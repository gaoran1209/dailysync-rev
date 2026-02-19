import { getGaminGlobalClient } from './garmin_global';
import { requestMfaCode, saveMfaState, loadMfaState } from '../mfa/garmin_sso_mfa';
import {
    AESKEY_DEFAULT,
    GARMIN_MIGRATE_NUM_DEFAULT,
    GARMIN_MIGRATE_START_DEFAULT,
    GARMIN_PASSWORD_DEFAULT,
    GARMIN_USERNAME_DEFAULT,
    GARMIN_SYNC_NUM_DEFAULT
} from '../constant';
import { downloadGarminActivity, uploadGarminActivity, sendBarkNotification, refreshAndSaveToken } from './garmin_common';
import { GarminClientType } from './type';
import { number2capital } from './number_tricks';
const core = require('@actions/core');
import _ from 'lodash';
import { getSessionFromDB, initDB, saveSessionToDB, updateSessionToDB } from './sqlite';

const CryptoJS = require('crypto-js');
const fs = require('fs');

const { GarminConnect } = require('@gooin/garmin-connect');

const GARMIN_USERNAME = process.env.GARMIN_USERNAME ?? GARMIN_USERNAME_DEFAULT;
const GARMIN_PASSWORD = process.env.GARMIN_PASSWORD ?? GARMIN_PASSWORD_DEFAULT;
const GARMIN_MIGRATE_NUM = process.env.GARMIN_MIGRATE_NUM ?? GARMIN_MIGRATE_NUM_DEFAULT;
const GARMIN_MIGRATE_START = process.env.GARMIN_MIGRATE_START ?? GARMIN_MIGRATE_START_DEFAULT;
const GARMIN_SYNC_NUM = process.env.GARMIN_SYNC_NUM ?? GARMIN_SYNC_NUM_DEFAULT;

/**
 * 统一的 SSO 登录处理函数（只发一次登录请求，避免重复邮件）
 * - MFA 账号：发送验证码邮件 + 保存 MFA state + Bark 通知
 * - 非 MFA 账号：直接用 ticket 完成登录
 */
async function handleSsoLogin(username: string, password: string): Promise<void> {
    try {
        // 如果已有同账号且未过期的 MFA 状态，避免重复触发验证码邮件
        try {
            const existingState = loadMfaState();
            if (existingState?.username && existingState.username === username) {
                console.log('🔐 检测到已有未过期 MFA 请求，跳过重复发送验证码邮件');
                const errMsg = '检测到已有未过期 MFA 验证码，请直接在 GitHub Actions 中触发 MFA Login workflow 完成登录';
                core.setFailed(errMsg);
                return;
            }
        } catch {
            // 无状态或已过期，继续发起新的 MFA 请求
        }

        const mfaState = await requestMfaCode(username, password);
        // MFA 账号：验证码邮件已发送
        saveMfaState(mfaState);
        console.log('🔐 MFA 验证码已发送，请检查邮箱');
        await sendBarkNotification('Garmin MFA 验证码已发送', '请检查邮箱，然后在 GitHub Actions 中触发 MFA Login workflow');
        const errMsg = '需要 MFA 验证，验证码已发送到邮箱，请在 GitHub Actions 中触发 MFA Login workflow';
        core.setFailed(errMsg);
    } catch (err) {
        if (err.message?.startsWith('NO_MFA_NEEDED:')) {
            // 非 MFA 账号：直接用 ticket 完成登录
            const ticket = err.message.split(':')[1];
            console.log('账号无需 MFA，直接完成登录...');
            const { exchangeAndSaveToken } = require('../mfa/garmin_sso_mfa');
            await exchangeAndSaveToken(ticket);
            console.log('✅ 登录成功，Token 已保存');
            await sendBarkNotification('Garmin CN 登录成功', '无需 MFA，已自动完成登录');
            return;
        }
        // 真正的错误
        console.error('❌ SSO 登录失败:', err.message);
        await sendBarkNotification('Garmin SSO 登录失败', err.message);
        core.setFailed(err.message);
        throw err;
    }
}

export const getGaminCNClient = async (): Promise<GarminClientType> => {
    if (_.isEmpty(GARMIN_USERNAME) || _.isEmpty(GARMIN_PASSWORD)) {
        const errMsg = '请填写中国区用户名及密码：GARMIN_USERNAME,GARMIN_PASSWORD';
        core.setFailed(errMsg);
        return Promise.reject(errMsg);
    }

    const GCClient = new GarminConnect({ username: GARMIN_USERNAME, password: GARMIN_PASSWORD }, 'garmin.cn');

    try {
        await initDB();

        const currentSession = await getSessionFromDB('CN');
        if (!currentSession) {
            // 首次登录：无 session，通过 SSO 流程登录（兼容 MFA 和非 MFA 账号）
            console.log('GarminCN: 无已保存的 session，开始 SSO 登录...');
            await handleSsoLogin(GARMIN_USERNAME, GARMIN_PASSWORD);
            return Promise.reject('SSO 登录流程已触发');
        } else {
            // 尝试用已保存的 session 登录
            try {
                console.log('GarminCN: login by saved session');
                await GCClient.loadToken(currentSession.oauth1, currentSession.oauth2);
            } catch (e) {
                // Token 失效，通过 SSO 流程重新登录（只发一次请求，避免重复邮件）
                console.log('Warn: GarminCN session expired, 通过 SSO 流程重新登录...');
                await handleSsoLogin(GARMIN_USERNAME, GARMIN_PASSWORD);
                return Promise.reject('SSO 登录流程已触发');
            }
        }

        const userInfo = await GCClient.getUserProfile();
        const { fullName, userName: emailAddress, location } = userInfo;
        if (!fullName) {
            throw Error('佳明中国区登录失败')
        }
        console.log('Garmin userInfo CN: ', { fullName, emailAddress, location });

        // 每次成功获取用户信息后，刷新并保存最新 token
        await refreshAndSaveToken(GCClient, 'CN');

        return GCClient;
    } catch (err) {
        console.error(err);
        core.setFailed(err);
    }
};

export const migrateGarminCN2GarminGlobal = async (count = 200) => {
    const actIndex = Number(GARMIN_MIGRATE_START) ?? 0;
    // const actPerGroup = 10;
    const totalAct = Number(GARMIN_MIGRATE_NUM) ?? count;

    const clientCN = await getGaminCNClient();
    const clientGlobal = await getGaminGlobalClient();

    const actSlices = await clientCN.getActivities(actIndex, totalAct);
    // only running
    // const runningActs = _.filter(actSlices, { activityType: { typeKey: 'running' } });

    const runningActs = actSlices;
    for (let j = 0; j < runningActs.length; j++) {
        const act = runningActs[j];
        // console.log({ act });
        // 下载佳明原始数据
        const filePath = await downloadGarminActivity(act.activityId, clientCN);
        // 上传到佳明国际区
        console.log(`本次开始向国际区上传第 ${number2capital(j + 1)} 条数据，相对总数上传到 ${number2capital(j + 1 + actIndex)} 条，  【 ${act.activityName} 】，开始于 【 ${act.startTimeLocal} 】，活动ID: 【 ${act.activityId} 】`);
        await uploadGarminActivity(filePath, clientGlobal);
        // await new Promise(resolve => setTimeout(resolve, 2000));
    }
};

export const syncGarminCN2GarminGlobal = async () => {
    const clientCN = await getGaminCNClient();
    const clientGlobal = await getGaminGlobalClient();

    let cnActs = await clientCN.getActivities(0, Number(GARMIN_SYNC_NUM));
    const globalActs = await clientGlobal.getActivities(0, 1);

    const latestGlobalActStartTime = globalActs[0]?.startTimeLocal ?? '0';
    const latestCnActStartTime = cnActs[0]?.startTimeLocal ?? '0';
    if (latestCnActStartTime === latestGlobalActStartTime) {
        console.log(`没有要同步的活动内容, 最近的活动:  【 ${cnActs[0].activityName} 】, 开始于: 【 ${latestCnActStartTime} 】`);
    } else {
        // fix: #18
        _.reverse(cnActs);
        let actualNewActivityCount = 1;
        for (let i = 0; i < cnActs.length; i++) {
            const cnAct = cnActs[i];
            if (cnAct.startTimeLocal > latestGlobalActStartTime) {
                // 下载佳明原始数据
                const filePath = await downloadGarminActivity(cnAct.activityId, clientCN);
                // 上传到佳明国际区
                console.log(`本次开始向国际区上传第 ${number2capital(actualNewActivityCount)} 条数据，【 ${cnAct.activityName} 】，开始于 【 ${cnAct.startTimeLocal} 】，活动ID: 【 ${cnAct.activityId} 】`);
                await uploadGarminActivity(filePath, clientGlobal);
                await new Promise(resolve => setTimeout(resolve, 1000));
                actualNewActivityCount++;
            }
        }
    }
};
