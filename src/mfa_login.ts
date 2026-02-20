/**
 * mfa_login.ts
 *
 * 使用用户提交的 MFA 验证码完成佳明中国区登录。
 * 需要先运行 request_mfa.ts 触发验证码邮件。
 *
 * 使用方式: yarn mfa_login --code 123456
 * 或通过环境变量: MFA_CODE=123456 yarn mfa_login
 */

import { BARK_KEY_DEFAULT } from './constant';
import { loadMfaState, verifyMfaCode, exchangeAndSaveToken, cleanMfaState } from './mfa/garmin_sso_mfa';
import { sendBarkNotification } from './utils/garmin_common';

const core = require('@actions/core');

function getCodeFromArgs(): string {
    // 优先从环境变量读取
    if (process.env.MFA_CODE) {
        return process.env.MFA_CODE.trim();
    }

    // 从命令行参数读取 --code 123456
    const args = process.argv;
    const codeIdx = args.indexOf('--code');
    if (codeIdx !== -1 && args[codeIdx + 1]) {
        return args[codeIdx + 1].trim();
    }

    throw new Error('请提供验证码: --code 123456 或设置环境变量 MFA_CODE');
}

function normalizeMfaCode(rawCode: string): string {
    // 兼容复制时带空格/连字符/全角空格等情况
    return rawCode
        .trim()
        .replace(/[^\dA-Za-z]/g, '');
}

async function main() {
    console.log('=== 佳明中国区 MFA 验证码登录 ===');

    let code: string;
    try {
        code = getCodeFromArgs();
    } catch (e) {
        console.error('❌', e.message);
        core.setFailed(e.message);
        return;
    }

    code = normalizeMfaCode(code);
    console.log(`验证码长度: ${code.length}`);
    if (code.length < 4) {
        const errMsg = '验证码格式异常，请确认输入的是邮件中的验证码';
        core.setFailed(errMsg);
        throw new Error(errMsg);
    }

    try {
        // 1. 加载 MFA 中间状态
        const mfaState = loadMfaState();
        console.log(`MFA 状态已加载，请求时间: ${new Date(mfaState.timestamp).toLocaleString()}`);
        const expectedUsername = process.env.GARMIN_USERNAME?.trim();
        if (expectedUsername && mfaState.username && mfaState.username !== expectedUsername) {
            const errMsg = `MFA 状态账号不匹配。state=${mfaState.username}, env=${expectedUsername}，请重新触发 Account 2 的验证码请求`;
            core.setFailed(errMsg);
            throw new Error(errMsg);
        }

        // 2. 提交验证码，获取 ServiceTicket
        const ticket = await verifyMfaCode(code, mfaState);
        console.log('ServiceTicket 获取成功');

        // 3. 用 ticket 交换 OAuth tokens 并保存
        await exchangeAndSaveToken(ticket);

        // 4. 清理临时状态文件
        cleanMfaState();

        console.log('');
        console.log('✅ MFA 登录成功！Token 已保存到数据库');
        console.log('🔄 后续定时同步 workflow 将自动使用新 Token');

        await sendBarkNotification('Garmin CN MFA 登录成功', 'Token 已更新，同步功能已恢复');
    } catch (e) {
        console.error('❌ MFA 登录失败:', e.message);
        await sendBarkNotification('Garmin CN MFA 登录失败', e.message);
        core.setFailed(e.message);
        throw e;
    }
}

main();
