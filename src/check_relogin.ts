/**
 * 账号2 国区重新登录的预检。不提交任何凭据，也不会触发验证码邮件，随时可以跑：
 *
 *   corepack yarn relogin:check
 *
 * 逐项确认 relogin:account2 依赖的东西都还能用，任何一项不通过就当场报错退出：
 *   1. Playwright 浏览器已安装。它放在全机共享的 ~/Library/Caches/ms-playwright，
 *      别的项目安装 Playwright 时会清理掉没有项目登记在用的版本。
 *   2. 用重新登录同一套浏览器配置打开国区登录页，账号、密码输入框都在。
 *   3. 163 邮箱的 IMAP 授权码有效，能打开收件箱。
 */

import * as fs from 'fs';
import { chromium } from 'playwright';
import { loadDotEnv } from './utils/dotenv';

loadDotEnv();

const { account2AuthService } = require('./service/account2_auth') as typeof import('./service/account2_auth');
const { getAccount2AuthConfig } = require('./service/config') as typeof import('./service/config');
const { checkMailbox } = require('./service/mail_code_fetcher') as typeof import('./service/mail_code_fetcher');

async function main(): Promise<void> {
    const executable = chromium.executablePath();
    if (!fs.existsSync(executable)) {
        throw new Error(`Playwright 浏览器不存在：${executable}\n   在仓库目录运行 corepack yarn install，会重新下载浏览器并登记本项目在用。`);
    }
    console.log(`✅ 浏览器已安装：${executable}`);

    const title = await account2AuthService.checkLoginPage();
    console.log(`✅ 国区登录页能打开，账号和密码输入框都在（页面标题：${title}）`);

    const mail = getAccount2AuthConfig().mail;
    if (!mail) {
        throw new Error('.env 里没有 MAIL_IMAP_PASSWORD，重新登录时无法自动读取验证码。');
    }
    await checkMailbox(mail);
    console.log(`✅ ${mail.user} 的 IMAP 授权码有效，收件箱能打开`);
}

main()
    .then(async () => {
        await account2AuthService.close();
        console.log('\n预检通过：国区 token 失效时可以直接跑 corepack yarn relogin:account2。');
        process.exit(0);
    })
    .catch(async (err) => {
        console.error(`❌ ${err?.message ?? err}`);
        await account2AuthService.close();
        process.exit(1);
    });
