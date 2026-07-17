/**
 * 在【住宅网络/本机】上给佳明国际区账号登录一次，导出 OAuth token。
 *
 * 为什么要本地跑：2026-03 起 sso.garmin.com 上了 Cloudflare 机器人检测，
 * 数据中心 IP（EC2/GitHub Actions）做密码登录会被 429 拦截。住宅 IP 正常。
 * 导出的 token（OAuth1 约 1 年有效）注入 EC2 后，EC2 只做刷新、不再密码登录。
 *
 * 用法（在项目根目录）：
 *   GARMIN_GLOBAL_USERNAME_2=xxx GARMIN_GLOBAL_PASSWORD_2=xxx yarn export_global_token
 * 或复用账号1 的国际区账号：
 *   GARMIN_GLOBAL_USERNAME=xxx GARMIN_GLOBAL_PASSWORD=xxx yarn export_global_token
 *
 * 成功后会在 ./db/global_token.json 写入 token，并把 JSON 打印到终端，
 * 复制到 EC2 管理页「导入国际区 Token」即可。
 */

const { GarminConnect } = require('@gooin/garmin-connect');
import * as fs from 'fs';

async function main() {
    const username = (process.env.GARMIN_GLOBAL_USERNAME_2 || process.env.GARMIN_GLOBAL_USERNAME || '').trim();
    const password = (process.env.GARMIN_GLOBAL_PASSWORD_2 || process.env.GARMIN_GLOBAL_PASSWORD || '').trim();
    if (!username || !password) {
        console.error('❌ 请提供国际区账号密码：GARMIN_GLOBAL_USERNAME_2 / GARMIN_GLOBAL_PASSWORD_2');
        process.exit(1);
    }

    console.log(`=== 导出佳明国际区 Token（账号: ${username}）===`);
    console.log('提示：请确保当前是住宅网络/家庭宽带出口，不要用机房/VPS 网络。');

    const client = new GarminConnect({ username, password });
    try {
        await client.login();
    } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (/\b429\b|too many requests|rate limit/i.test(msg)) {
            console.error('❌ 登录被 429 拦截。可能原因：');
            console.error('   1) 当前不是住宅 IP（机房/公司网络也可能被拦），换家庭宽带重试；');
            console.error('   2) 该账号因之前反复自动登录进入了 48-72h 账号级封锁，等封锁解除后再试。');
            process.exit(2);
        }
        console.error('❌ 登录失败:', msg);
        process.exit(2);
    }

    let profileName = '(未知)';
    try {
        const p = await client.getUserProfile();
        profileName = p?.userName || p?.displayName || p?.fullName || profileName;
    } catch { /* 忽略：token 已拿到，profile 拉取失败不影响导出 */ }

    const token = client.exportToken(); // { oauth1, oauth2 }
    const payload = { sessionUser: username, region: 'GLOBAL', token };

    const outDir = './db';
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = `${outDir}/global_token.json`;
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    console.log('');
    console.log(`✅ 登录成功（账号显示名: ${profileName}），token 已写入 ${outPath}`);
    console.log('');
    console.log('👉 复制下面这段 JSON，粘贴到 EC2 管理页「导入国际区 Token」输入框：');
    console.log('----------8<----------');
    console.log(JSON.stringify(payload));
    console.log('---------->8----------');
}

main().catch((e) => {
    console.error('导出失败:', e?.message ?? e);
    process.exit(1);
});
