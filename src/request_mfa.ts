/**
 * request_mfa.ts
 *
 * 请求佳明中国区发送 MFA 验证码邮件。
 * 执行后会将 MFA 中间状态（CSRF + cookies）保存到 db/mfa_state.json，
 * 供 mfa_login.ts 使用。
 *
 * 使用方式: yarn request_mfa
 */

import { GARMIN_PASSWORD_DEFAULT, GARMIN_USERNAME_DEFAULT, BARK_KEY_DEFAULT } from './constant';
import { requestMfaCode, saveMfaState, loadMfaState } from './mfa/garmin_sso_mfa';
import { sendBarkNotification } from './utils/garmin_common';

const core = require('@actions/core');
const axios = require('axios');

const GARMIN_USERNAME = process.env.GARMIN_USERNAME ?? GARMIN_USERNAME_DEFAULT;
const GARMIN_PASSWORD = process.env.GARMIN_PASSWORD ?? GARMIN_PASSWORD_DEFAULT;

async function main() {
    console.log('=== 请求佳明中国区 MFA 验证码 ===');

    if (!GARMIN_USERNAME || !GARMIN_PASSWORD) {
        const errMsg = '请填写中国区用户名及密码：GARMIN_USERNAME, GARMIN_PASSWORD';
        core.setFailed(errMsg);
        throw new Error(errMsg);
    }

    // 避免重复发送验证码邮件
    try {
        const existingState = loadMfaState();
        if (!existingState?.username || existingState.username === GARMIN_USERNAME) {
            console.log('🔐 检测到已有未过期 MFA 请求，跳过重复发送验证码邮件');
            await sendBarkNotification(
                'Garmin MFA 验证码已存在',
                '检测到已有未过期验证码请求，请直接在 GitHub Actions 中触发 MFA Login workflow',
            );
            return;
        }
    } catch {
        // 无状态或已过期，继续发起请求
    }

    try {
        const mfaState = await requestMfaCode(GARMIN_USERNAME, GARMIN_PASSWORD);

        // 保存 MFA 状态到文件（供 mfa_login workflow 使用）
        saveMfaState(mfaState);

        console.log('');
        console.log('✅ 验证码邮件已发送！');
        console.log('📧 请检查邮箱，获取 6 位验证码');
        console.log('⏰ 验证码有效期 30 分钟');
        console.log('👉 请在 GitHub Actions 中触发 "MFA Login" workflow，输入验证码');

        await sendBarkNotification(
            'Garmin MFA 验证码已发送',
            '请检查邮箱获取验证码，然后在 GitHub Actions 中触发 MFA Login workflow',
        );
    } catch (e) {
        if (e.message?.startsWith('NO_MFA_NEEDED:')) {
            // 账号不需要 MFA，直接用 ticket 完成登录
            const ticket = e.message.split(':')[1];
            console.log('账号无需 MFA，直接完成登录...');

            const { exchangeAndSaveToken } = require('./mfa/garmin_sso_mfa');
            await exchangeAndSaveToken(ticket);
            console.log('✅ 登录成功，Token 已保存');
            await sendBarkNotification('Garmin CN 登录成功', '无需 MFA，已自动完成登录');
        } else {
            console.error('❌ 请求 MFA 失败:', e.message);
            await sendBarkNotification('Garmin MFA 请求失败', e.message);
            core.setFailed(e.message);
            throw e;
        }
    }
}

main();
