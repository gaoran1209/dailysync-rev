import {
    GARMIN_GLOBAL_PASSWORD_DEFAULT,
    GARMIN_GLOBAL_USERNAME_DEFAULT,
    GARMIN_MIGRATE_NUM_DEFAULT,
    GARMIN_MIGRATE_START_DEFAULT,
    GARMIN_SYNC_NUM_DEFAULT,
} from '../constant';
import { getGaminCNClient } from './garmin_cn';
import { GarminClientType, GarminLoginOptions, GarminSyncOptions } from './type';
import { downloadGarminActivity, uploadGarminActivity, sendBarkNotification, refreshAndSaveToken } from './garmin_common';
import { number2capital } from './number_tricks';
import { getSessionFromDB, initDB, saveSessionToDB, updateSessionToDB } from './sqlite';

const { GarminConnect } = require('@gooin/garmin-connect');

const GARMIN_GLOBAL_USERNAME = process.env.GARMIN_GLOBAL_USERNAME ?? GARMIN_GLOBAL_USERNAME_DEFAULT;
const GARMIN_GLOBAL_PASSWORD = process.env.GARMIN_GLOBAL_PASSWORD ?? GARMIN_GLOBAL_PASSWORD_DEFAULT;
const GARMIN_MIGRATE_NUM = process.env.GARMIN_MIGRATE_NUM ?? GARMIN_MIGRATE_NUM_DEFAULT;
const GARMIN_MIGRATE_START = process.env.GARMIN_MIGRATE_START ?? GARMIN_MIGRATE_START_DEFAULT;
const GARMIN_SYNC_NUM = process.env.GARMIN_SYNC_NUM ?? GARMIN_SYNC_NUM_DEFAULT;

interface ResolvedGarminGlobalOptions {
    username: string;
    password: string;
    sessionUser: string;
}

function isRateLimited(err: any): boolean {
    const status = err?.response?.status ?? err?.status;
    if (status === 429) return true;
    return /\b429\b|too many requests|rate limit/i.test(String(err?.message ?? ''));
}

function resolveGlobalOptions(options: GarminLoginOptions = {}): ResolvedGarminGlobalOptions {
    const username = (options.username ?? GARMIN_GLOBAL_USERNAME)?.trim();
    const password = (options.password ?? GARMIN_GLOBAL_PASSWORD)?.trim();
    if (!username || !password) {
        throw new Error('请填写国际区用户名及密码：GARMIN_GLOBAL_USERNAME,GARMIN_GLOBAL_PASSWORD');
    }
    return {
        username,
        password,
        sessionUser: (options.sessionUser ?? username).trim(),
    };
}

export const getGaminGlobalClient = async (options: GarminLoginOptions = {}): Promise<GarminClientType> => {
    const config = resolveGlobalOptions(options);
    const GCClient = new GarminConnect({ username: config.username, password: config.password });

    await initDB();

    const currentSession = await getSessionFromDB('GLOBAL', config.sessionUser);
    if (!currentSession) {
        try {
            await GCClient.login();
            await saveSessionToDB('GLOBAL', GCClient.exportToken(), config.sessionUser);
        } catch (loginErr) {
            if (isRateLimited(loginErr)) {
                // 国际区登录被限流（多为短时间多次登录导致），本次跳过，稍后自动重试
                throw new Error(`TRANSIENT_ERROR: 佳明国际区登录被限流(429)，本次跳过，稍后重试`);
            }
            const errMsg = `佳明国际区首次登录失败: ${loginErr.message}`;
            console.error(errMsg);
            await sendBarkNotification('Garmin Global 登录失败', errMsg);
            throw new Error(errMsg);
        }
    } else {
        GCClient.loadToken(currentSession.oauth1, currentSession.oauth2);
        try {
            await GCClient.getUserProfile();
        } catch {
            console.log('Warn: renew GarminGlobal session..');
            try {
                await GCClient.login(config.username, config.password);
                await updateSessionToDB('GLOBAL', GCClient.exportToken(), config.sessionUser);
            } catch (loginErr) {
                if (isRateLimited(loginErr)) {
                    throw new Error(`TRANSIENT_ERROR: 佳明国际区重新登录被限流(429)，本次跳过，稍后重试`);
                }
                const errMsg = `佳明国际区 Token 过期且重新登录失败: ${loginErr.message}`;
                console.error(errMsg);
                await sendBarkNotification('Garmin Global 登录失败', errMsg);
                throw new Error(errMsg);
            }
        }
    }

    try {
        const userInfo = await GCClient.getUserProfile();
        const { fullName, userName: emailAddress, location } = userInfo;
        if (!emailAddress) {
            throw new Error('佳明国际区登录失败，请检查填入的账号密码或您的网络环境');
        }
        console.log('Garmin userInfo global', { fullName, emailAddress, location });
        await refreshAndSaveToken(GCClient, 'GLOBAL', config.sessionUser);
        return GCClient;
    } catch (err) {
        console.error(err);
        throw err;
    }
};

export const migrateGarminGlobal2GarminCN = async (count = 200, options: GarminSyncOptions = {}) => {
    const actIndex = Number(GARMIN_MIGRATE_START) ?? 0;
    const totalAct = Number(GARMIN_MIGRATE_NUM) ?? count;

    const clientGlobal = await getGaminGlobalClient(options.global);
    const clientCn = await getGaminCNClient(options.cn);

    const actSlices = await clientGlobal.getActivities(actIndex, totalAct);
    const runningActs = actSlices;
    for (let j = 0; j < runningActs.length; j++) {
        const act = runningActs[j];
        const filePath = await downloadGarminActivity(act.activityId, clientGlobal);
        console.log(`本次开始向中国区上传第 ${number2capital(j + 1)} 条数据，相对总数上传到 ${number2capital(j + 1 + actIndex)} 条，  【 ${act.activityName} 】，开始于 【 ${act.startTimeLocal} 】，活动ID: 【 ${act.activityId} 】`);
        await uploadGarminActivity(filePath, clientCn);
    }
};

export const syncGarminGlobal2GarminCN = async (options: GarminSyncOptions = {}) => {
    const clientCN = await getGaminCNClient(options.cn);
    const clientGlobal = await getGaminGlobalClient(options.global);

    const cnActs = await clientCN.getActivities(0, 1);
    const globalActs = await clientGlobal.getActivities(0, Number(GARMIN_SYNC_NUM));

    const latestGlobalActStartTime = globalActs[0]?.startTimeLocal ?? '0';
    const latestCnActStartTime = cnActs[0]?.startTimeLocal ?? '0';

    if (latestCnActStartTime === latestGlobalActStartTime) {
        console.log(`没有要同步的活动内容, 最近的活动:  【 ${globalActs[0]?.activityName} 】, 开始于: 【 ${latestGlobalActStartTime} 】`);
    } else {
        const reversedActs = [...globalActs].reverse();
        let actualNewActivityCount = 0;
        for (const globalAct of reversedActs) {
            if (globalAct.startTimeLocal > latestCnActStartTime) {
                const filePath = await downloadGarminActivity(globalAct.activityId, clientGlobal);
                actualNewActivityCount += 1;
                console.log(`本次开始向中国区上传第 ${number2capital(actualNewActivityCount)} 条数据，【 ${globalAct.activityName} 】，开始于 【 ${globalAct.startTimeLocal} 】，活动ID: 【 ${globalAct.activityId} 】`);
                await uploadGarminActivity(filePath, clientCN);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
};
