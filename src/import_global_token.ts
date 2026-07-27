/**
 * 把「浏览器铸票」导出的国际区 OAuth token 写进本机数据库。
 *
 *   yarn import:global-token 2            # 默认读 ~/.dailysync/global_token.json
 *   yarn import:global-token 1 /path/to/global_token.json
 *
 * 上一步是 yarn export:global-token（见 README「国际区 token 过期了怎么办」）。
 */

import { loadDotEnv } from './utils/dotenv';

loadDotEnv();

const fs = require('fs') as typeof import('fs');
const { GLOBAL_TOKEN_PATH, HTTP_TIMEOUT_MS } = require('./constant') as typeof import('./constant');
const { getAccount } = require('./accounts') as typeof import('./accounts');
const { closeDB, getSessionFromDB, initDB, saveSessionToDB, updateSessionToDB } = require('./utils/sqlite') as typeof import('./utils/sqlite');
const { GarminConnect } = require('@gooin/garmin-connect');

async function main(): Promise<number> {
    const id = process.argv[2]?.trim();
    if (id !== '1' && id !== '2') {
        console.error('用法: yarn import:global-token <1|2> [token.json 路径]');
        return 1;
    }
    const tokenPath = process.argv[3]?.trim() || GLOBAL_TOKEN_PATH;
    if (!fs.existsSync(tokenPath)) {
        console.error(`❌ 找不到 token 文件: ${tokenPath}`);
        console.error('   先跑 yarn export:global-token 生成它。');
        return 1;
    }

    const account = getAccount(id);
    const sessionUser = account.sync.global.sessionUser;

    // 兼容两种格式：{sessionUser, region, token:{oauth1,oauth2}} 或直接 {oauth1,oauth2}
    const payload = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    const token = payload?.token ?? payload;
    const oauth1 = token?.oauth1;
    const oauth2 = token?.oauth2 ?? {};
    if (!oauth1?.oauth_token || !oauth1?.oauth_token_secret) {
        console.error('❌ token 格式不对：缺少 oauth1.oauth_token / oauth_token_secret');
        return 1;
    }

    // 先在线校验一次；失败不阻断导入（可能只是网络问题），但要如实告诉用户
    let validated = '';
    try {
        const client = new GarminConnect({
            username: account.sync.global.username,
            password: account.sync.global.password,
            timeout: HTTP_TIMEOUT_MS,
        });
        client.loadToken(oauth1, oauth2);
        const profile = await client.getUserProfile();
        validated = profile?.userName || profile?.displayName || profile?.fullName || '(已连通)';
    } catch (e: any) {
        console.log(`⚠️  在线校验失败（不阻断保存）: ${e?.message}`);
    }

    await initDB();
    const existing = await getSessionFromDB('GLOBAL', sessionUser);
    if (existing) {
        await updateSessionToDB('GLOBAL', { oauth1, oauth2 }, sessionUser);
    } else {
        await saveSessionToDB('GLOBAL', { oauth1, oauth2 }, sessionUser);
    }

    console.log(validated
        ? `✅ ${account.label} 国际区 token 已导入并校验成功（账号: ${validated}）`
        : `✅ ${account.label} 国际区 token 已导入保存（未能在线校验，下次同步时验证）`);
    console.log(`   下一步：yarn sync ${id}`);
    return 0;
}

main()
    .then(async (code) => {
        await closeDB();
        process.exit(code);
    })
    .catch(async (err) => {
        console.error('导入失败:', err?.message ?? err);
        await closeDB().catch(() => undefined);
        process.exit(1);
    });
