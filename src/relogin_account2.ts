/**
 * 账号2 国区重新登录（开了 ECG，强制邮箱验证码）。
 *
 *   yarn relogin:account2
 *
 * 流程：Playwright 打开 sso.garmin.cn 提交账号密码 → 佳明发验证码邮件 →
 * IMAP 轮询 163 邮箱自动取码 → 提交 → 截获一次性 ServiceTicket → 换 OAuth token 落库。
 *
 * 预期一年只需要跑 1~2 次（OAuth1 长效）。跑之前确认 .env 里有 MAIL_IMAP_PASSWORD
 * （163 的 IMAP 授权码，不是登录密码）。
 */

import { loadDotEnv } from './utils/dotenv';

loadDotEnv();

const { getAccount } = require('./accounts') as typeof import('./accounts');
const { account2AuthService } = require('./service/account2_auth') as typeof import('./service/account2_auth');
const { closeDB, getSessionFromDB } = require('./utils/sqlite') as typeof import('./utils/sqlite');

async function main(): Promise<number> {
    const account = getAccount('2');
    const sessionUser = account.sync.cn.sessionUser;

    if (!account2AuthService.canAutoLogin) {
        console.error('❌ .env 里没有 MAIL_IMAP_PASSWORD，无法自动读取验证码。');
        console.error('   去 mail.163.com → 设置 → POP3/SMTP/IMAP 开启服务并生成授权码，写进 .env 后重试。');
        return 1;
    }

    console.log('开始账号2 国区重新登录（会弹出浏览器窗口，全程自动，约 1~5 分钟）...');
    const result = await account2AuthService.autoLogin();
    console.log(`\n结果: ${result.status} — ${result.message}`);

    // 不能只看 autoLogin 的返回值：token 落库之后它还会再打一次 getUserProfile 做收尾校验，
    // 那一步遇到网络抖动会报错，但 token 其实已经存好了。以库里的实际内容为准。
    const session = await getSessionFromDB('CN', sessionUser);
    if (session?.oauth1?.oauth_token) {
        console.log('✅ 库里已有账号2 国区的有效 OAuth1，重新登录成功。');
        console.log('   下一步：yarn sync 2 验证一次同步。');
        return 0;
    }

    console.error('❌ 库里仍然没有账号2 国区的有效 token。');
    console.error('   常见原因：验证码邮件进了垃圾箱 / 163 授权码失效 / 佳明改了登录页 DOM。');
    return 1;
}

main()
    .then(async (code) => {
        await account2AuthService.close();
        await closeDB();
        process.exit(code);
    })
    .catch(async (err) => {
        console.error('重新登录异常:', err?.message ?? err);
        await account2AuthService.close().catch(() => undefined);
        await closeDB().catch(() => undefined);
        process.exit(1);
    });
