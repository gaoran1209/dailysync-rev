import { getGaminGlobalClient } from './garmin_global';
import { requestMfaCode, saveMfaState } from '../mfa/garmin_sso_mfa';
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
            // 首次登录：无 session，尝试直接登录
            // 如果开启了 ECG/MFA，这里会失败，需要用 MFA 流程
            try {
                await GCClient.login();
                await saveSessionToDB('CN', GCClient.exportToken());
            } catch (loginErr) {
                // 登录失败（MFA 账号），自动请求验证码
                console.log('🔐 首次登录失败，需要 MFA 验证，自动请求验证码...');
                try {
                    const mfaState = await requestMfaCode(GARMIN_USERNAME, GARMIN_PASSWORD);
                    saveMfaState(mfaState);
                    await sendBarkNotification('Garmin MFA 验证码已发送', '请检查邮箱，然后在 GitHub Actions 中触发 MFA Login workflow');
                } catch (mfaErr) {
                    if (mfaErr.message?.startsWith('NO_MFA_NEEDED:')) {
                        const ticket = mfaErr.message.split(':')[1];
                        console.log('账号无需 MFA，直接完成登录...');
                        const { exchangeAndSaveToken } = require('../mfa/garmin_sso_mfa');
                        await exchangeAndSaveToken(ticket);
                        console.log('✅ 登录成功，Token 已保存');
                        await sendBarkNotification('Garmin CN 登录成功', '无需 MFA，已自动完成登录');
                        return getGaminCNClient(); // 重新获取 client
                    }
                    await sendBarkNotification('Garmin MFA 请求失败', mfaErr.message);
                }
                const errMsg = '需要 MFA 验证，验证码已发送到邮箱，请在 GitHub Actions 中触发 MFA Login workflow';
                core.setFailed(errMsg);
                return Promise.reject(errMsg);
            }
        } else {
            //  Wrap error message in GCClient, prevent terminate in github actions.
            try {
                console.log('GarminCN: login by saved session');
                await GCClient.loadToken(currentSession.oauth1, currentSession.oauth2);
            } catch (e) {
                // Token 失效：先尝试重新登录（非 MFA 账号可以直接成功）
                console.log('Warn: GarminCN session expired, trying re-login...');
                try {
                    await GCClient.login(GARMIN_USERNAME, GARMIN_PASSWORD);
                    const newToken = GCClient.exportToken();
                    await updateSessionToDB('CN', newToken);
                    console.log('GarminCN: re-login 成功，Token 已更新');
                } catch (loginErr) {
                    // re-login 也失败（MFA 账号），自动请求验证码
                    console.log('🔐 Token 过期且重新登录失败，需要 MFA 验证，自动请求验证码...');
                    try {
                        const mfaState = await requestMfaCode(GARMIN_USERNAME, GARMIN_PASSWORD);
                        saveMfaState(mfaState);
                        await sendBarkNotification('Garmin MFA 验证码已发送', '请检查邮箱，然后在 GitHub Actions 中触发 MFA Login workflow');
                    } catch (mfaErr) {
                        if (mfaErr.message?.startsWith('NO_MFA_NEEDED:')) {
                            const ticket = mfaErr.message.split(':')[1];
                            console.log('账号无需 MFA，直接完成登录...');
                            const { exchangeAndSaveToken } = require('../mfa/garmin_sso_mfa');
                            await exchangeAndSaveToken(ticket);
                            console.log('✅ 登录成功，Token 已保存');
                            await sendBarkNotification('Garmin CN 登录成功', '无需 MFA，已自动完成登录');
                            return getGaminCNClient(); // 重新获取 client
                        }
                        await sendBarkNotification('Garmin MFA 请求失败', mfaErr.message);
                    }
                    const errMsg = '需要 MFA 验证，验证码已发送到邮箱，请在 GitHub Actions 中触发 MFA Login workflow';
                    core.setFailed(errMsg);
                    return Promise.reject(errMsg);
                }
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
