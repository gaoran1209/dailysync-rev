import { GARMIN_SYNC_NUM_DEFAULT, HTTP_TIMEOUT_MS } from '../constant';
import { exchangeAndSaveToken, ssoPasswordLogin } from '../mfa/garmin_sso_mfa';
import {
    createReauthRequiredError,
    createTransientError,
    downloadGarminActivity,
    isAuthFailure,
    refreshAndSaveToken,
    sendBarkNotification,
    uploadGarminActivity,
    verifyProfileWithRetry,
} from './garmin_common';
import { getGaminGlobalClient } from './garmin_global';
import { number2capital } from './number_tricks';
import { GarminClientType, GarminLoginOptions, GarminSyncOptions, GarminSyncResult } from './type';
import {
    deleteSessionFromDB,
    getSessionFromDB,
    initDB,
    markAccountAuthReady,
    markAccountAuthReauthRequired,
} from './sqlite';

const { GarminConnect } = require('@gooin/garmin-connect');

const GARMIN_SYNC_NUM = Number(process.env.GARMIN_SYNC_NUM) || GARMIN_SYNC_NUM_DEFAULT;

function newCnClient(config: GarminLoginOptions): GarminClientType {
    return new GarminConnect({
        username: config.username,
        // 库的构造函数不接受空密码；同步路径根本不会用到它，占位即可
        password: config.password || '-',
        timeout: HTTP_TIMEOUT_MS,
    }, 'garmin.cn');
}

const RELOGIN_HINT = (config: GarminLoginOptions) => config.authStateKey === 'ACCOUNT2'
    ? '请在本机跑 yarn relogin:account2'
    : '请在本机跑 yarn relogin:cn 1';

/**
 * 拿一个可用的国区客户端。**只消费已存的 token，不做任何登录动作。**
 * token 没了或真失效就抛 REAUTH_REQUIRED，由人跑 relogin 命令。
 */
export const getGaminCNClient = async (config: GarminLoginOptions): Promise<GarminClientType> => {
    await initDB();

    const currentSession = await getSessionFromDB('CN', config.sessionUser);
    if (!currentSession) {
        if (config.authStateKey) {
            await markAccountAuthReauthRequired(config.authStateKey, '国区 token 不存在，需要重新登录');
        }
        throw createReauthRequiredError('CN', config.label, `库里没有 token，${RELOGIN_HINT(config)}`);
    }

    const client = newCnClient(config);
    client.loadToken(currentSession.oauth1, currentSession.oauth2);
    try {
        const userInfo = await verifyProfileWithRetry(client, config.label);
        console.log(`[${config.label}] 国区登录态有效:`, { fullName: userInfo?.fullName });
        await refreshAndSaveToken(client, 'CN', config.sessionUser);
        if (config.authStateKey) {
            await markAccountAuthReady(config.authStateKey);
        }
        return client;
    } catch (err: any) {
        // 只有确凿的认证失效才动长效 OAuth1；网络抖动/5xx/超时一律保留登录态跳过本次
        if (!isAuthFailure(err)) {
            throw createTransientError(`${config.label} 国区`, err?.message ?? '未知网络错误');
        }
        await deleteSessionFromDB('CN', config.sessionUser);
        if (config.authStateKey) {
            await markAccountAuthReauthRequired(config.authStateKey, err?.message ?? '国区 token 已失效');
        }
        throw createReauthRequiredError('CN', config.label, `token 已失效，${RELOGIN_HINT(config)}`);
    }
};

/**
 * 用账号密码重新登录国区并落库。只由 `yarn relogin:cn` 显式调用，
 * 适用于没有开 MFA 的账号（账号1）。账号2 走 relogin:account2。
 */
export const reloginCnWithPassword = async (
    config: GarminLoginOptions & { password: string },
): Promise<void> => {
    await initDB();
    const result = await ssoPasswordLogin(config.username, config.password);

    if (result.outcome === 'mfa_required') {
        throw new Error(`${config.label} 需要邮箱验证码，密码登录走不通，请改跑 yarn relogin:account2`);
    }
    if (result.outcome === 'rejected') {
        throw new Error(`${config.label} 登录被拒绝（多半是账号密码不对）: ${result.detail}`);
    }

    await exchangeAndSaveToken(result.ticket, { region: 'CN', sessionUser: config.sessionUser });

    const client = newCnClient(config);
    const refreshed = await getSessionFromDB('CN', config.sessionUser);
    if (!refreshed) {
        throw new Error(`${config.label} 登录后仍未在库里拿到有效 token`);
    }
    client.loadToken(refreshed.oauth1, refreshed.oauth2);
    const userInfo = await verifyProfileWithRetry(client, config.label);
    console.log(`[${config.label}] 重新登录成功:`, { fullName: userInfo?.fullName });
    await refreshAndSaveToken(client, 'CN', config.sessionUser);
    if (config.authStateKey) {
        await markAccountAuthReady(config.authStateKey);
    }
    await sendBarkNotification(`${config.label} 已重新登录`, 'token 已刷新');
};

/** 上传时佳明返回的重复活动标志（409/duplicate），视为「已存在」而非失败 */
export function isDuplicateUploadError(err: any): boolean {
    const status = err?.response?.status ?? err?.status;
    if (status === 409) return true;
    const msg = String(err?.message ?? '') + JSON.stringify(err?.response?.data ?? '');
    return /duplicat|already\s*exist|409/i.test(msg);
}

/**
 * 用活动的「时间指纹」做集合差集比对，而不是单点水位线字符串比较。
 * 指纹用 startTimeGMT（绝对时间，避免时区问题）优先，回退 startTimeLocal，
 * 再拼上时长/距离降低同名碰撞。这样乱序补传、同名活动、跨时区都不会漏。
 */
export function activityFingerprint(act: Record<string, any>): string {
    const rawTime = String(act?.startTimeGMT ?? act?.startTimeLocal ?? '');
    const t = rawTime.replace('T', ' ').slice(0, 19).trim();
    const dur = Math.round(Number(act?.duration ?? 0));
    const dist = Math.round(Number(act?.distance ?? 0));
    return `${t}|${dur}|${dist}`;
}

export const syncGarminCN2GarminGlobal = async (options: GarminSyncOptions): Promise<GarminSyncResult> => {
    const clientCN = await getGaminCNClient(options.cn);
    const clientGlobal = await getGaminGlobalClient(options.global);

    const windowSize = GARMIN_SYNC_NUM;
    const cnActs = await clientCN.getActivities(0, windowSize);
    // 国际区也取同样大小的窗口，用集合差集判断哪些国区活动尚未同步
    const globalActs = await clientGlobal.getActivities(0, windowSize);

    const latestGlobalActStartTime = globalActs[0]?.startTimeLocal ?? '0';
    const latestCnActStartTime = cnActs[0]?.startTimeLocal ?? '0';

    const globalFingerprints = new Set(globalActs.map(activityFingerprint));
    const pending = [...cnActs]
        .filter(act => !globalFingerprints.has(activityFingerprint(act)))
        .reverse();

    if (pending.length === 0) {
        const message = `没有要同步的活动内容, 最近的活动: 【 ${cnActs[0]?.activityName ?? '暂无'} 】, 开始于: 【 ${latestCnActStartTime} 】`;
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
        // 无原始文件的活动（手动录入等）跳过，不阻塞后续活动
        let filePath: string;
        try {
            filePath = await downloadGarminActivity(cnAct.activityId, clientCN);
        } catch (downloadErr: any) {
            skippedCount += 1;
            console.log(`跳过无法下载原始数据的活动【 ${cnAct.activityName} 】(ID ${cnAct.activityId}): ${downloadErr.message}`);
            continue;
        }

        try {
            console.log(`本次开始向国际区上传第 ${number2capital(uploadedCount + 1)} 条数据，【 ${cnAct.activityName} 】，开始于 【 ${cnAct.startTimeLocal} 】，活动ID: 【 ${cnAct.activityId} 】`);
            await uploadGarminActivity(filePath, clientGlobal);
            uploadedCount += 1;
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (uploadErr: any) {
            if (isDuplicateUploadError(uploadErr)) {
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
        await sendBarkNotification(`${options.cn.label} 部分同步失败`, message);
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
        message: uploadedCount > 0 ? `已同步 ${uploadedCount} 条活动到国际区` : '未找到需要同步的新活动',
        latestSourceStartTime: latestCnActStartTime,
        latestTargetStartTime: latestGlobalActStartTime,
    };
};
