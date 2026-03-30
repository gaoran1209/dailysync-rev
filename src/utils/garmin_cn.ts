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
            const { exchangeAndSaveToken } = require('../mfa/garmin_sso_mfa');
            await exchangeAndSaveToken(ticket, { region: 'CN', sessionUser: config.sessionUser });
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
        throw new Error('MFA_REQUESTED: SSO 登录流程已触发');
    }

    GCClient.loadToken(currentSession.oauth1, currentSession.oauth2);

    try {
        const userInfo = await GCClient.getUserProfile();
        const { fullName, userName: emailAddress, location } = userInfo;
        if (!fullName) {
            throw new Error('佳明中国区登录失败');
        }
        console.log('Garmin userInfo CN: ', { fullName, emailAddress, location });
        await refreshAndSaveToken(GCClient, 'CN', config.sessionUser);
        if (config.authStateKey) {
            await markAccountAuthReady(config.authStateKey);
        }
        return GCClient;
    } catch (err) {
        if (config.loginMode === 'token_only') {
            await deleteSessionFromDB('CN', config.sessionUser);
            if (config.authStateKey) {
                await markAccountAuthReauthRequired(config.authStateKey, err.message ?? 'Garmin CN token 已失效');
            }
            throw createReauthRequiredError();
        }

        console.log('Warn: GarminCN session expired, 通过 SSO 流程重新登录...');
        await handleSsoLogin(config);
        throw new Error('MFA_REQUESTED: SSO 登录流程已触发');
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

export const syncGarminCN2GarminGlobal = async (options: GarminSyncOptions = {}): Promise<GarminSyncResult> => {
    const clientCN = await getGaminCNClient(options.cn);
    const clientGlobal = await getGaminGlobalClient(options.global);

    const cnActs = await clientCN.getActivities(0, Number(GARMIN_SYNC_NUM));
    const globalActs = await clientGlobal.getActivities(0, 1);

    const latestGlobalActStartTime = globalActs[0]?.startTimeLocal ?? '0';
    const latestCnActStartTime = cnActs[0]?.startTimeLocal ?? '0';

    if (latestCnActStartTime === latestGlobalActStartTime) {
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

    const reversedActs = [...cnActs].reverse();
    let uploadedCount = 0;
    for (const cnAct of reversedActs) {
        if (cnAct.startTimeLocal > latestGlobalActStartTime) {
            const filePath = await downloadGarminActivity(cnAct.activityId, clientCN);
            uploadedCount += 1;
            console.log(`本次开始向国际区上传第 ${number2capital(uploadedCount)} 条数据，【 ${cnAct.activityName} 】，开始于 【 ${cnAct.startTimeLocal} 】，活动ID: 【 ${cnAct.activityId} 】`);
            await uploadGarminActivity(filePath, clientGlobal);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    return {
        status: 'ok',
        uploadedCount,
        message: uploadedCount > 0 ? `已同步 ${uploadedCount} 条 Garmin CN 活动到国际区` : '未找到需要同步的新活动',
        latestSourceStartTime: latestCnActStartTime,
        latestTargetStartTime: latestGlobalActStartTime,
    };
};
