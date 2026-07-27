import * as fs from 'fs';
import * as path from 'path';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { AESKEY_DEFAULT, DB_FILE_PATH } from '../constant';

const CryptoJS = require('crypto-js');

const AESKEY = AESKEY_DEFAULT;

export type GarminSessionRegion = 'CN' | 'GLOBAL';
export type AccountAuthStatus = 'ready' | 'awaiting_code' | 'reauth_required' | 'error';

export interface AccountAuthState {
    accountKey: string;
    status: AccountAuthStatus;
    lastSuccessAt: number | null;
    lastError: string | null;
    lastErrorAt: number | null;
    updatedAt: number;
}

/**
 * sessionUser 必须显式传。以前这里会兜底到 process.env.GARMIN_USERNAME，
 * 结果是任何一处漏传都会静默地把 A 账号的 token 写进 B 账号的行——sqlite 是二进制，
 * 覆盖了就只能翻备份。现在漏传会当场抛错。
 */
function resolveSessionUser(sessionUser: string | undefined): string {
    const resolved = sessionUser?.trim();
    if (!resolved) {
        throw new Error('内部错误：调用 session 存取时未传 sessionUser');
    }
    return resolved;
}

/**
 * 判断解出来的东西是不是一份真 session。
 *
 * 背景：历史上有一次 ticket 交换拿到的是佳明「未登录」页面的 HTML，代码没校验就
 * 存了进去，于是库里躺着一个 5000 多键的字符索引对象。它是 truthy，会绕过
 * 「没有 session」的判断，一路走到 loadToken({}) → 401 → 被当成瞬时错误，
 * 表现为每次同步静默空转、永远不提示需要重新登录。
 */
function isValidSession(session: any): boolean {
    const oauth1 = session?.oauth1;
    return Boolean(oauth1 && typeof oauth1 === 'object' && oauth1.oauth_token && oauth1.oauth_token_secret);
}

let dbInstance: Awaited<ReturnType<typeof open>> | null = null;

export const getDB = async () => {
    if (!dbInstance) {
        fs.mkdirSync(path.dirname(DB_FILE_PATH), { recursive: true });
        dbInstance = await open({
            filename: DB_FILE_PATH,
            driver: sqlite3.Database,
        });
        await dbInstance.run('PRAGMA journal_mode=WAL');
    }
    return dbInstance;
};

/**
 * 收尾必须调这个。WAL 模式下，进程被 process.exit() 强制退出时不会 checkpoint，
 * 新写入只留在 -wal 文件里；账号2 的重新登录 CLI 因为 Playwright 常驻 Chromium
 * 吊住事件循环、必须强退，不做 checkpoint 就会静默丢掉刚拿到的 token。
 */
export const closeDB = async () => {
    if (!dbInstance) return;
    const db = dbInstance;
    dbInstance = null;
    try {
        await db.run('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e: any) {
        console.log('[DB] checkpoint 失败:', e?.message);
    }
    await db.close().catch(() => undefined);
};

export const initDB = async () => {
    const db = await getDB();
    await db.exec(`CREATE TABLE IF NOT EXISTS garmin_session (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user VARCHAR(255),
            region VARCHAR(20),
            session  TEXT
        )`);
    await db.exec(`CREATE TABLE IF NOT EXISTS account_auth_state (
            account_key TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            last_success_at INTEGER,
            last_error TEXT,
            last_error_at INTEGER,
            updated_at INTEGER NOT NULL
        )`);
};

export const saveSessionToDB = async (
    type: GarminSessionRegion,
    session: Record<string, any>,
    sessionUser: string,
) => {
    const db = await getDB();
    const user = resolveSessionUser(sessionUser);
    if (!isValidSession(session)) {
        throw new Error(`拒绝写入无效的 ${type} session（缺少 oauth1.oauth_token），不覆盖已有 token`);
    }
    const encryptedSessionStr = encryptSession(session);
    await db.run('DELETE FROM garmin_session WHERE user = ? AND region = ?', user, type);
    await db.run('INSERT INTO garmin_session (user,region,session) VALUES (?,?,?)', user, type, encryptedSessionStr);
};

export const updateSessionToDB = async (
    type: GarminSessionRegion,
    session: Record<string, any>,
    sessionUser: string,
) => {
    const db = await getDB();
    const user = resolveSessionUser(sessionUser);
    if (!isValidSession(session)) {
        throw new Error(`拒绝写入无效的 ${type} session（缺少 oauth1.oauth_token），不覆盖已有 token`);
    }
    const encryptedSessionStr = encryptSession(session);
    const result = await db.run(
        'UPDATE garmin_session SET session = ? WHERE user = ? AND region = ?',
        encryptedSessionStr,
        user,
        type,
    );
    if (!result.changes) {
        await db.run('INSERT INTO garmin_session (user,region,session) VALUES (?,?,?)', user, type, encryptedSessionStr);
    }
};

export const deleteSessionFromDB = async (type: GarminSessionRegion, sessionUser: string) => {
    const db = await getDB();
    const user = resolveSessionUser(sessionUser);
    await db.run('DELETE FROM garmin_session WHERE user = ? AND region = ?', user, type);
};

export const getSessionFromDB = async (
    type: GarminSessionRegion,
    sessionUser: string,
): Promise<Record<string, any> | undefined> => {
    const db = await getDB();
    const user = resolveSessionUser(sessionUser);
    const queryResult = await db.get(
        'SELECT session FROM garmin_session WHERE user = ? AND region = ? ORDER BY id DESC LIMIT 1',
        user,
        type,
    );
    if (!queryResult) {
        return undefined;
    }
    let session: Record<string, any>;
    try {
        session = decryptSession(queryResult.session);
    } catch (e: any) {
        // AESKEY 变更或数据损坏时按无 session 处理，走重新登录而不是让整个同步崩掉
        console.log(`[DB] ${type}/${user} session 解密失败（AESKEY 可能已更换），按无 session 处理: ${e.message}`);
        return undefined;
    }
    if (!isValidSession(session)) {
        console.log(`[DB] ${type}/${user} 库里的 session 结构不合法（缺少 oauth1），按无 session 处理`);
        return undefined;
    }
    return session;
};

export const getAccountAuthState = async (accountKey: string): Promise<AccountAuthState | undefined> => {
    const db = await getDB();
    const row = await db.get(
        `SELECT
            account_key as accountKey,
            status,
            last_success_at as lastSuccessAt,
            last_error as lastError,
            last_error_at as lastErrorAt,
            updated_at as updatedAt
         FROM account_auth_state
         WHERE account_key = ?`,
        accountKey,
    );
    return row ?? undefined;
};

async function upsertAccountAuthState(
    accountKey: string,
    status: AccountAuthStatus,
    options: {
        lastSuccessAt?: number | null;
        lastError?: string | null;
        lastErrorAt?: number | null;
    } = {},
): Promise<AccountAuthState> {
    const db = await getDB();
    const previous = await getAccountAuthState(accountKey);
    const now = Date.now();
    const nextState: AccountAuthState = {
        accountKey,
        status,
        lastSuccessAt: options.lastSuccessAt !== undefined ? options.lastSuccessAt : previous?.lastSuccessAt ?? null,
        lastError: options.lastError !== undefined ? options.lastError : previous?.lastError ?? null,
        lastErrorAt: options.lastErrorAt !== undefined ? options.lastErrorAt : previous?.lastErrorAt ?? null,
        updatedAt: now,
    };
    await db.run(
        `INSERT INTO account_auth_state (
            account_key, status, last_success_at, last_error, last_error_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET
            status = excluded.status,
            last_success_at = excluded.last_success_at,
            last_error = excluded.last_error,
            last_error_at = excluded.last_error_at,
            updated_at = excluded.updated_at`,
        nextState.accountKey,
        nextState.status,
        nextState.lastSuccessAt,
        nextState.lastError,
        nextState.lastErrorAt,
        nextState.updatedAt,
    );
    return nextState;
}

export const markAccountAuthReady = async (accountKey: string) => {
    return upsertAccountAuthState(accountKey, 'ready', {
        lastSuccessAt: Date.now(),
        lastError: null,
        lastErrorAt: null,
    });
};

export const markAccountAuthAwaitingCode = async (accountKey: string, lastError?: string | null) => {
    return upsertAccountAuthState(accountKey, 'awaiting_code', {
        lastError: lastError ?? null,
        lastErrorAt: lastError ? Date.now() : null,
    });
};

export const markAccountAuthReauthRequired = async (accountKey: string, lastError?: string | null) => {
    return upsertAccountAuthState(accountKey, 'reauth_required', {
        lastError: lastError ?? null,
        lastErrorAt: lastError ? Date.now() : null,
    });
};

export const markAccountAuthError = async (accountKey: string, lastError: string) => {
    return upsertAccountAuthState(accountKey, 'error', {
        lastError,
        lastErrorAt: Date.now(),
    });
};

export const encryptSession = (session: Record<string, any>): string => {
    return CryptoJS.AES.encrypt(JSON.stringify(session), AESKEY).toString();
};

export const decryptSession = (sessionStr: string): Record<string, any> => {
    const bytes = CryptoJS.AES.decrypt(sessionStr, AESKEY);
    return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
};
