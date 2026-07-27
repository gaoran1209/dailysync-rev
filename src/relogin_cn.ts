/**
 * 用账号密码重新登录国区（适用于没开 MFA 的账号1）。
 *
 *   yarn relogin:cn 1
 *
 * 账号2 开了 ECG，强制邮箱验证码，密码登录走不通 —— 用 yarn relogin:account2。
 */

import { loadDotEnv } from './utils/dotenv';

loadDotEnv();

const { getAccount, requirePassword } = require('./accounts') as typeof import('./accounts');
const { reloginCnWithPassword } = require('./utils/garmin_cn') as typeof import('./utils/garmin_cn');
const { closeDB } = require('./utils/sqlite') as typeof import('./utils/sqlite');

async function main(): Promise<number> {
    const id = process.argv[2]?.trim();
    if (id !== '1' && id !== '2') {
        console.error('用法: yarn relogin:cn <1|2>');
        return 1;
    }
    const account = getAccount(id);
    const cn = account.sync.cn;
    const password = requirePassword(cn);

    console.log(`开始用账号密码重新登录 ${cn.label}...`);
    await reloginCnWithPassword({ ...cn, password });
    console.log(`✅ 完成。下一步：yarn sync ${id}`);
    return 0;
}

main()
    .then(async (code) => {
        await closeDB();
        process.exit(code);
    })
    .catch(async (err) => {
        console.error('❌', err?.message ?? err);
        await closeDB().catch(() => undefined);
        process.exit(1);
    });
