import { AESKEY_DEFAULT, DB_FILE_PATH, GARMIN_USERNAME_DEFAULT } from '../constant';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const CryptoJS = require('crypto-js');

const GARMIN_USERNAME = process.env.GARMIN_USERNAME ?? GARMIN_USERNAME_DEFAULT;
const AESKEY = process.env.AESKEY ?? AESKEY_DEFAULT;

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

function resolveSessionUser(sessionUser?: string): string {
    const resolved = sessionUser?.trim() || GARMIN_USERNAME?.trim();
    if (!resolved) {
        throw new Error('未提供 Garmin session user，请检查账号环境变量配置');
    }
    return resolved;
}

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

let dbInstance: Awaited<ReturnType<typeof open>> | null = null;

export const getDB = async () => {
    if (!dbInstance) {
        dbInstance = await open({
            filename: DB_FILE_PATH,
            driver: sqlite3.Database,
        });
        await dbInstance.run('PRAGMA journal_mode=WAL');
    }
    return dbInstance;
};

export const saveSessionToDB = async (
    type: GarminSessionRegion,
    session: Record<string, any>,
    sessionUser?: string,
) => {
    const db = await getDB();
    const user = resolveSessionUser(sessionUser);
    const encryptedSessionStr = encryptSession(session);
    await db.run('DELETE FROM garmin_session WHERE user = ? AND region = ?', user, type);
    await db.run(
        `INSERT INTO garmin_session (user,region,session) VALUES (?,?,?)`,
        user,
        type,
        encryptedSessionStr,
    );
};

export const updateSessionToDB = async (
    type: GarminSessionRegion,
    session: Record<string, any>,
    sessionUser?: string,
) => {
    const db = await getDB();
    const user = resolveSessionUser(sessionUser);
    const encryptedSessionStr = encryptSession(session);
    const result = await db.run(
        'UPDATE garmin_session SET session = ? WHERE user = ? AND region = ?',
        encryptedSessionStr,
        user,
        type,
    );
    if (!result.changes) {
        await db.run(
            `INSERT INTO garmin_session (user,region,session) VALUES (?,?,?)`,
            user,
            type,
            encryptedSessionStr,
        );
    }
};

export const deleteSessionFromDB = async (type: GarminSessionRegion, sessionUser?: string) => {
    const db = await getDB();
    const user = resolveSessionUser(sessionUser);
    await db.run('DELETE FROM garmin_session WHERE user = ? AND region = ?', user, type);
};

export const getSessionFromDB = async (
    type: GarminSessionRegion,
    sessionUser?: string,
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
    return decryptSession(queryResult.session);
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
            account_key,
            status,
            last_success_at,
            last_error,
            last_error_at,
            updated_at
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
    const sessionStr = JSON.stringify(session);
    return CryptoJS.AES.encrypt(sessionStr, AESKEY).toString();
};

export const decryptSession = (sessionStr: string): Record<string, any> => {
    const bytes = CryptoJS.AES.decrypt(sessionStr, AESKEY);
    const session = bytes.toString(CryptoJS.enc.Utf8);
    return JSON.parse(session);
};
