import { getGaminGlobalClient } from './garmin_global';
import { requestMfaCode, saveMfaState, loadMfaState } from '../mfa/garmin_sso_mfa';
import {
    GARMIN_MIGRATE_NUM_DEFAULT,
    GARMIN_MIGRATE_START_DEFAULT,
    GARMIN_PASSWORD_DEFAULT,
    GARMIN_USERNAME_DEFAULT,
    GARMIN_SYNC_NUM_DEFAULT,
} from '../constant';
import { downloadGarminActivity, uploadGarminActivity, sendBarkNotification, refreshAndSaveToken } from './garmin_common';
import { GarminClientType, GarminLoginOptions, GarminSyncOptions, GarminSyncResult } from './type';
import { number2capital } from './number_tricks';
const core = require('@actions/core');
import { deleteSessionFromDB, getSessionFromDB, initDB, markAccountAuthReady, markAccountAuthReauthRequired } from './sqlite';

const { GarminConnect } = require('@gooin/garmin-connect');

const GARMIN_USERNAME = process.env.GARMIN_USERNAME ?? GARMIN_USERNAME_DEFAULT;
const GARMIN_PASSWORD = process.env.GARMIN_PASSWORD ?? GARMIN_PASSWORD_DEFAULT;
const GARMIN_MIGRATE_NUM = process.env.GARMIN_MIGRATE_NUM ?? GARMIN_MIGRATE_NUM_DEFAULT;
const GARMIN_MIGRATE_START = process.env.GARMIN_MIGRATE_START ?? GARMIN_MIGRATE_START_DEFAULT;
const GARMIN_SYNC_NUM = process.env.GARMIN_SYNC_NUM ?? GARMIN_SYNC_NUM_DEFAULT;

interface ResolvedGarminLoginOptions {
    username: string;
    password: string;
    sessionUser: string;
    loginMode: 'legacy_mfa' | 'token_only';
    authStateKey?: string;
}

function resolveCnOptions(options: GarminLoginOptions = {}): ResolvedGarminLoginOptions {
    const username = (options.username ?? GARMIN_USERNAME)?.trim();
    const password = (options.password ?? GARMIN_PASSWORD)?.trim();
    if (!username || !password) {
        throw new Error('请填写中国区用户名及密码：GARMIN_USERNAME,GARMIN_PASSWORD');
    }
    return {
        username,
        password,
        sessionUser: (options.sessionUser ?? username).trim(),
        loginMode: options.loginMode ?? 'legacy_mfa',
        authStateKey: options.authStateKey,
    };
}

function createReauthRequiredError(): Error {
    return new Error('REAUTH_REQUIRED: Garmin CN 登录状态失效，请在 EC2 管理页重新登录');
}

function createTransientError(cause: string): Error {
    return new Error(`TRANSIENT_ERROR: Garmin CN 暂时不可用（${cause}），本次跳过，保留登录态`);
}

/**
 * 判断错误是否为“认证失效”（token 真的死了，需要重新登录）。
 * 网络抖动 / 5xx / 超时不属于此类，不应删除长效 OAuth1 token。
 */
export function isAuthFailure(err: any): boolean {
    const status = err?.response?.status ?? err?.status;
    if (status === 401 || status === 403) return true;
    const code = err?.code;
    // 明确的网络类错误 → 一定不是认证失效
    if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED'].includes(code)) {
        return false;
    }
    const msg = String(err?.message ?? '');
    if (/\b(401|403)\b|unauthor|forbidden|invalid[_\s-]?token|token.*(expired|invalid)|refresh.*fail/i.test(msg)) {
        return true;
    }
    // 库在 token 失效时抛的 "佳明中国区登录失败"（fullName 缺失）
    if (msg.includes('佳明中国区登录失败')) return true;
    return false;
}

/**
 * 校验当前 token 是否可用，对瞬时错误做有限重试。
 * @returns userInfo（成功）
 * @throws isAuthFailure=true 的错误（认证失效）或最后一次瞬时错误
 */
async function verifyProfileWithRetry(GCClient: GarminClientType, attempts = 3): Promise<any> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
        try {
            const userInfo = await GCClient.getUserProfile();
            if (!userInfo?.fullName) {
                throw new Error('佳明中国区登录失败');
            }
            return userInfo;
        } catch (err) {
            lastErr = err;
            if (isAuthFailure(err)) {
                throw err; // 认证失效，无需重试
            }
            // 瞬时错误，退避后重试
            if (i < attempts - 1) {
                const backoffMs = 2000 * (i + 1);
                console.log(`[GarminCN] getUserProfile 第 ${i + 1} 次失败（${err.message}），${backoffMs}ms 后重试...`);
                await new Promise(r => setTimeout(r, backoffMs));
            }
        }
    }
    throw lastErr;
}

/**
 * 统一的 SSO 登录处理函数（只发一次登录请求，避免重复邮件）
 * - MFA 账号：发送验证码邮件 + 保存 MFA state + Bark 通知
 * - 非 MFA 账号：直接用 ticket 完成登录
 */
async function handleSsoLogin(config: ResolvedGarminLoginOptions): Promise<void> {
    try {
        // 如果已有同账号且未过期的 MFA 状态，避免重复触发验证码邮件
        try {
            const existingState = loadMfaState();
            if (!existingState?.username || existingState.username === config.username) {
                console.log('🔐 检测到已有未过期 MFA 请求，跳过重复发送验证码邮件');
                const errMsg = '检测到已有未过期 MFA 验证码，请直接在 GitHub Actions 中触发 MFA Login workflow 完成登录';
                core.setFailed(errMsg);
                return;
            }
        } catch {
            // 无状态或已过期，继续发起新的 MFA 请求
        }

        const mfaState = await requestMfaCode(config.username, config.password);
        saveMfaState(mfaState);
        console.log('🔐 MFA 验证码已发送，请检查邮箱');
        await sendBarkNotification('Garmin MFA 验证码已发送', '请检查邮箱，然后在 GitHub Actions 中触发 MFA Login workflow');
        const errMsg = '需要 MFA 验证，验证码已发送到邮箱，请在 GitHub Actions 中触发 MFA Login workflow';
        core.setFailed(errMsg);
    } catch (err) {
        if (err.message?.startsWith('NO_MFA_NEEDED:')) {
            const ticket = err.message.split(':')[1];
            console.log('账号无需 MFA，直接完成登录...');
            try {
                const { exchangeAndSaveToken } = require('../mfa/garmin_sso_mfa');
                await exchangeAndSaveToken(ticket, { region: 'CN', sessionUser: config.sessionUser });
            } catch (exchangeErr) {
                // ticket 交换失败时回退到库的完整 login 流程（无 MFA 账号可用）
                console.log('Ticket 交换失败，回退到库 login:', exchangeErr.message);
                const GCClient = new GarminConnect({ username: config.username, password: config.password }, 'garmin.cn');
                await GCClient.login(config.username, config.password);
                await refreshAndSaveToken(GCClient, 'CN', config.sessionUser);
            }
            console.log('✅ 登录成功，Token 已保存');
            await sendBarkNotification('Garmin CN 登录成功', '无需 MFA，已自动完成登录');
            return;
        }
        console.error('❌ SSO 登录失败:', err.message);
        await sendBarkNotification('Garmin SSO 登录失败', err.message);
        core.setFailed(err.message);
        throw err;
    }
}

export const getGaminCNClient = async (options: GarminLoginOptions = {}): Promise<GarminClientType> => {
    const config = resolveCnOptions(options);
    const GCClient = new GarminConnect({ username: config.username, password: config.password }, 'garmin.cn');

    await initDB();

    const currentSession = await getSessionFromDB('CN', config.sessionUser);
    if (!currentSession) {
        if (config.loginMode === 'token_only') {
            if (config.authStateKey) {
                await markAccountAuthReauthRequired(config.authStateKey, 'Garmin CN token 不存在，请先重新登录');
            }
            throw createReauthRequiredError();
        }
        console.log('GarminCN: 无已保存的 session，开始 SSO 登录...');
        await handleSsoLogin(config);
        // 无 MFA 账号会在 handleSsoLogin 内直接完成登录并保存 session，此时继续本次同步
        const refreshedSession = await getSessionFromDB('CN', config.sessionUser);
        if (!refreshedSession) {
            throw new Error('MFA_REQUESTED: SSO 登录流程已触发');
        }
        GCClient.loadToken(refreshedSession.oauth1, refreshedSession.oauth2);
        const userInfo = await GCClient.getUserProfile();
        console.log('Garmin userInfo CN: ', { fullName: userInfo?.fullName });
        await refreshAndSaveToken(GCClient, 'CN', config.sessionUser);
        if (config.authStateKey) {
            await markAccountAuthReady(config.authStateKey);
        }
        return GCClient;
    }

    GCClient.loadToken(currentSession.oauth1, currentSession.oauth2);

    try {
        const userInfo = await verifyProfileWithRetry(GCClient);
        const { fullName, userName: emailAddress, location } = userInfo;
        console.log('Garmin userInfo CN: ', { fullName, emailAddress, location });
        await refreshAndSaveToken(GCClient, 'CN', config.sessionUser);
        if (config.authStateKey) {
            await markAccountAuthReady(config.authStateKey);
        }
        return GCClient;
    } catch (err) {
        if (config.loginMode === 'token_only') {
            // 只有真正的认证失效才删除长效 OAuth1 token 并要求重新登录；
            // 网络抖动/5xx/超时保留 session，抛可重试错误，本次同步跳过即可
            if (!isAuthFailure(err)) {
                console.log('[GarminCN] token 校验遇到瞬时错误，保留登录态，本次跳过:', err.message);
                throw createTransientError(err.message ?? '未知网络错误');
            }
            await deleteSessionFromDB('CN', config.sessionUser);
            if (config.authStateKey) {
                await markAccountAuthReauthRequired(config.authStateKey, err.message ?? 'Garmin CN token 已失效');
            }
            throw createReauthRequiredError();
        }

        console.log('Warn: GarminCN session expired, 通过 SSO 流程重新登录...');
        // 先删除失效 session，这样重查到 session 就说明 handleSsoLogin 完成了新登录
        await deleteSessionFromDB('CN', config.sessionUser);
        await handleSsoLogin(config);
        const refreshedSession = await getSessionFromDB('CN', config.sessionUser);
        if (!refreshedSession) {
            throw new Error('MFA_REQUESTED: SSO 登录流程已触发');
        }
        GCClient.loadToken(refreshedSession.oauth1, refreshedSession.oauth2);
        const userInfo = await GCClient.getUserProfile();
        console.log('Garmin userInfo CN: ', { fullName: userInfo?.fullName });
        await refreshAndSaveToken(GCClient, 'CN', config.sessionUser);
        if (config.authStateKey) {
            await markAccountAuthReady(config.authStateKey);
        }
        return GCClient;
    }
};

export const migrateGarminCN2GarminGlobal = async (count = 200, options: GarminSyncOptions = {}) => {
    const actIndex = Number(GARMIN_MIGRATE_START) ?? 0;
    const totalAct = Number(GARMIN_MIGRATE_NUM) ?? count;

    const clientCN = await getGaminCNClient(options.cn);
    const clientGlobal = await getGaminGlobalClient(options.global);

    const actSlices = await clientCN.getActivities(actIndex, totalAct);
    const runningActs = actSlices;
    for (let j = 0; j < runningActs.length; j++) {
        const act = runningActs[j];
        const filePath = await downloadGarminActivity(act.activityId, clientCN);
        console.log(`本次开始向国际区上传第 ${number2capital(j + 1)} 条数据，相对总数上传到 ${number2capital(j + 1 + actIndex)} 条，  【 ${act.activityName} 】，开始于 【 ${act.startTimeLocal} 】，活动ID: 【 ${act.activityId} 】`);
        await uploadGarminActivity(filePath, clientGlobal);
    }
};

/** 上传成功后 Garmin 返回的重复活动标志（409/duplicate），视为“已存在”而非失败 */
export function isDuplicateUploadError(err: any): boolean {
    const status = err?.response?.status ?? err?.status;
    if (status === 409) return true;
    const msg = String(err?.message ?? '') + JSON.stringify(err?.response?.data ?? '');
    return /duplicat|already\s*exist|409/i.test(msg);
}

/**
 * 用活动的“时间指纹”做集合差集比对，而不是单点水位线字符串比较。
 * 指纹用 startTimeGMT（绝对时间，避免时区问题）优先，回退 startTimeLocal，
 * 再拼上时长/距离降低同名碰撞。这样：乱序补传、同名活动、跨时区都不会漏。
 */
export function activityFingerprint(act: Record<string, any>): string {
    // 归一化时间字符串：统一 'T'/空格分隔、去掉毫秒/时区尾巴，取到秒
    const rawTime = String(act?.startTimeGMT ?? act?.startTimeLocal ?? '');
    const t = rawTime.replace('T', ' ').slice(0, 19).trim();
    const dur = Math.round(Number(act?.duration ?? 0));
    const dist = Math.round(Number(act?.distance ?? 0));
    return `${t}|${dur}|${dist}`;
}

export const syncGarminCN2GarminGlobal = async (options: GarminSyncOptions = {}): Promise<GarminSyncResult> => {
    const clientCN = await getGaminCNClient(options.cn);
    const clientGlobal = await getGaminGlobalClient(options.global);

    const windowSize = Number(GARMIN_SYNC_NUM) || 10;
    const cnActs = await clientCN.getActivities(0, windowSize);
    // 国际区也取同样大小的窗口，用集合差集判断哪些 CN 活动尚未同步
    const globalActs = await clientGlobal.getActivities(0, windowSize);

    const latestGlobalActStartTime = globalActs[0]?.startTimeLocal ?? '0';
    const latestCnActStartTime = cnActs[0]?.startTimeLocal ?? '0';

    const globalFingerprints = new Set(globalActs.map(activityFingerprint));
    // 待同步：CN 窗口内、指纹不在国际区窗口中的活动，按时间旧→新处理
    const pending = [...cnActs]
        .filter(act => !globalFingerprints.has(activityFingerprint(act)))
        .reverse();

    if (pending.length === 0) {
        const message = `没有要同步的活动内容, 最近的活动:  【 ${cnActs[0]?.activityName ?? '暂无'} 】, 开始于: 【 ${latestCnActStartTime} 】`;
        console.log(message);
        return {
            status: 'no_new_data',
            uploadedCount: 0,
            message,
            latestSourceStartTime: latestCnActStartTime,
            latestTargetStartTime: latestGlobalActStartTime,
        };
    }

    let uploadedCount = 0;
    let skippedCount = 0;
    const failures: string[] = [];

    for (const cnAct of pending) {
        // 下载原始 FIT：无原始文件的活动（手动录入等）跳过，不阻塞后续活动
        let filePath: string;
        try {
            filePath = await downloadGarminActivity(cnAct.activityId, clientCN);
        } catch (downloadErr) {
            skippedCount += 1;
            console.log(`跳过无法下载原始数据的活动【 ${cnAct.activityName} 】(ID ${cnAct.activityId}): ${downloadErr.message}`);
            continue;
        }

        try {
            console.log(`本次开始向国际区上传第 ${number2capital(uploadedCount + 1)} 条数据，【 ${cnAct.activityName} 】，开始于 【 ${cnAct.startTimeLocal} 】，活动ID: 【 ${cnAct.activityId} 】`);
            await uploadGarminActivity(filePath, clientGlobal);
            uploadedCount += 1;
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (uploadErr) {
            if (isDuplicateUploadError(uploadErr)) {
                // 国际区已有该活动（指纹没命中但实际重复），当作已同步
                console.log(`活动【 ${cnAct.activityName} 】国际区已存在，跳过`);
                continue;
            }
            // 真实上传失败：记录但不中断，集合差集会在下次运行自动重试该活动
            failures.push(`${cnAct.activityName}(${cnAct.activityId}): ${uploadErr.message}`);
            console.log(`上传失败【 ${cnAct.activityName} 】(ID ${cnAct.activityId}): ${uploadErr.message}`);
        }
    }

    if (failures.length > 0) {
        const message = `已同步 ${uploadedCount} 条，${failures.length} 条上传失败（将于下次自动重试）: ${failures.join('; ')}`;
        console.log(message);
        await sendBarkNotification('Garmin CN→Global 部分同步失败', message);
        return {
            status: 'partial',
            uploadedCount,
            failedCount: failures.length,
            skippedCount,
            message,
            latestSourceStartTime: latestCnActStartTime,
            latestTargetStartTime: latestGlobalActStartTime,
        };
    }

    return {
        status: 'ok',
        uploadedCount,
        failedCount: 0,
        skippedCount,
        message: uploadedCount > 0 ? `已同步 ${uploadedCount} 条 Garmin CN 活动到国际区` : '未找到需要同步的新活动',
        latestSourceStartTime: latestCnActStartTime,
        latestTargetStartTime: latestGlobalActStartTime,
    };
};
