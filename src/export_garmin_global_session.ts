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

import * as fs from 'fs';
import * as https from 'https';
import * as qs from 'qs';
import * as crypto from 'crypto';
const OAuth = require('oauth-1.0a');

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CONNECTMOBILE_UA = 'com.garmin.android.apps.connectmobile';
const SSO = 'https://sso.garmin.com/sso';
const SSO_EMBED = `${SSO}/embed`;
const OAUTH_URL = 'https://connectapi.garmin.com/oauth-service/oauth';
const OAUTH_CONSUMER_URL = 'https://thegarth.s3.amazonaws.com/oauth_consumer.json';

interface HttpsResp { status: number; headers: Record<string, any>; body: string; }

/**
 * 用 Node 裸 https 发请求：Cloudflare 对 axios/follow-redirects 的请求指纹
 * 返回 301 自循环软拦截，但裸 https.request 可正常通过（实测）。
 */
function httpsRequest(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<HttpsResp> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
            host: u.host,
            path: u.pathname + u.search,
            method: options.method ?? 'GET',
            family: 4,
            timeout: 30_000,
            headers: { 'User-Agent': BROWSER_UA, ...(options.headers ?? {}) },
        }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf-8') }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(new Error('https request timeout')); });
        if (options.body) req.write(options.body);
        req.end();
    });
}

function mergeCookies(existing: string, setCookie: string | string[] | undefined): string {
    if (!setCookie) return existing;
    const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
    const map = new Map<string, string>();
    if (existing) {
        existing.split(';').forEach(c => {
            const [k, ...v] = c.trim().split('=');
            if (k) map.set(k.trim(), v.join('=').trim());
        });
    }
    headers.forEach(h => {
        const parts = h.split(';')[0].trim().split('=');
        if (parts[0]) map.set(parts[0].trim(), parts.slice(1).join('=').trim());
    });
    return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 裸 https 版国际区登录：embed 建 cookie → signin 取 CSRF → POST 凭据拿 ticket。
 * 与 @gooin/garmin-connect 1.8.7 的登录参数完全一致（service=sso/embed），
 * 因此 ticket 可直接交给库的 getOauth1Token/exchange 换 OAuth token。
 */
export async function loginViaBareHttps(username: string, password: string): Promise<string> {
    // Step 1: embed 建初始 cookie（跟随最多 5 次重定向）
    let cookies = '';
    let url = `${SSO_EMBED}?${qs.stringify({ clientId: 'GarminConnect', locale: 'en', service: 'https://connect.garmin.com/modern' })}`;
    for (let hop = 0; hop < 5; hop++) {
        const r = await httpsRequest(url, { headers: cookies ? { Cookie: cookies } : {} });
        cookies = mergeCookies(cookies, r.headers['set-cookie']);
        const loc = r.headers['location'];
        if (r.status >= 300 && r.status < 400 && loc) {
            const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
            if (next === url) throw new Error(`SSO embed 被 Cloudflare 301 自循环拦截（status ${r.status}），换个网络出口再试`);
            url = next;
            continue;
        }
        if (r.status !== 200) throw new Error(`SSO embed 返回 ${r.status}`);
        break;
    }

    // Step 2: signin 页取 CSRF
    const signinGetUrl = `${SSO}/signin?${qs.stringify({ id: 'gauth-widget', embedWidget: true, locale: 'en', gauthHost: SSO_EMBED })}`;
    const page = await httpsRequest(signinGetUrl, { headers: { Cookie: cookies, Referer: SSO_EMBED } });
    cookies = mergeCookies(cookies, page.headers['set-cookie']);
    if (page.status !== 200) throw new Error(`signin 页面返回 ${page.status}`);
    const csrfMatch = page.body.match(/name="_csrf"\s+value="(.+?)"/);
    if (!csrfMatch) throw new Error('未能从 signin 页面提取 CSRF token');

    // Step 3: POST 凭据换 ticket（参数与库 1.8.7 的 step3Params 一致）
    const signinPostUrl = `${SSO}/signin?${qs.stringify({
        id: 'gauth-widget', embedWidget: true, clientId: 'GarminConnect', locale: 'en',
        gauthHost: SSO_EMBED, service: SSO_EMBED, source: SSO_EMBED,
        redirectAfterAccountLoginUrl: SSO_EMBED, redirectAfterAccountCreationUrl: SSO_EMBED,
    })}`;
    const form = qs.stringify({ username, password, embed: 'true', _csrf: csrfMatch[1] });
    const post = await httpsRequest(signinPostUrl, {
        method: 'POST',
        body: form,
        headers: {
            Cookie: cookies,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': String(Buffer.byteLength(form)),
            Origin: 'https://sso.garmin.com',
            Referer: signinGetUrl,
            Dnt: '1',
        },
    });
    if (post.status === 429) throw new Error('429: 登录被限流/封锁（账号级封锁一般 48-72h），稍后再试');
    const ticketMatch = post.body.match(/ticket=([^"]+)"/);
    if (!ticketMatch) {
        if (/verifyMFA|mfa-code/i.test(post.body)) throw new Error('该国际区账号也开启了 MFA，暂不支持本脚本自动处理');
        if (/locked/i.test(post.body)) throw new Error('账号被锁定，请先在浏览器解锁');
        throw new Error(`登录 POST 未返回 ticket（status ${post.status}），请检查账号密码。页面片段: ${post.body.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    return ticketMatch[1];
}

async function fetchConsumer(): Promise<{ key: string; secret: string }> {
    const r = await httpsRequest(OAUTH_CONSUMER_URL);
    const j = JSON.parse(r.body);
    return { key: j.consumer_key, secret: j.consumer_secret };
}

/**
 * 用 ServiceTicket 换 OAuth1/OAuth2 token —— 全程裸 https + OAuth1 签名。
 * 不走 @gooin/garmin-connect 的 axios（其在 sso/connectapi 上会被 Cloudflare 以 301 自循环/401 拦截）。
 * 产出与库 exportToken() 一致的 { oauth1, oauth2 } 结构，可直接 loadToken。
 */
async function exchangeTicketForTokens(ticket: string): Promise<{ oauth1: any; oauth2: any }> {
    const consumer = await fetchConsumer();
    const oauth = new OAuth({
        consumer,
        signature_method: 'HMAC-SHA1',
        hash_function(base: string, key: string) {
            return crypto.createHmac('sha1', key).update(base).digest('base64');
        },
    });

    // Step A: preauthorized → OAuth1 token
    const preUrl = `${OAUTH_URL}/preauthorized?${qs.stringify({ ticket, 'login-url': SSO_EMBED, 'accepts-mfa-tokens': true })}`;
    const preHeaders = oauth.toHeader(oauth.authorize({ url: preUrl, method: 'GET' }));
    const preResp = await httpsRequest(preUrl, { headers: { ...preHeaders, 'User-Agent': CONNECTMOBILE_UA } });
    if (preResp.status !== 200) {
        throw new Error(`OAuth1 preauthorized 返回 ${preResp.status}: ${preResp.body.slice(0, 100)}`);
    }
    const oauth1 = qs.parse(preResp.body) as any;
    if (!oauth1.oauth_token || !oauth1.oauth_token_secret) {
        throw new Error('OAuth1 响应缺少 token');
    }

    // Step B: exchange → OAuth2 token
    const exUrl = `${OAUTH_URL}/exchange/user/2.0`;
    const token = { key: String(oauth1.oauth_token), secret: String(oauth1.oauth_token_secret) };
    const exSigned = oauth.authorize({ url: exUrl, method: 'POST', data: null }, token);
    const exFull = `${exUrl}?${qs.stringify(exSigned)}`;
    const exResp = await httpsRequest(exFull, {
        method: 'POST',
        headers: { 'User-Agent': CONNECTMOBILE_UA, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (exResp.status !== 200) {
        throw new Error(`OAuth2 exchange 返回 ${exResp.status}: ${exResp.body.slice(0, 100)}`);
    }
    const oauth2 = JSON.parse(exResp.body);

    // 附加过期字段（与库 setOauth2TokenExpiresAt 一致，供后续刷新判断）
    const nowSec = Math.floor(Date.now() / 1000);
    oauth2.last_update_date = new Date().toISOString();
    oauth2.expires_date = new Date((nowSec + Number(oauth2.expires_in || 0)) * 1000).toISOString();
    oauth2.expires_at = nowSec + Number(oauth2.expires_in || 0);
    oauth2.refresh_token_expires_at = nowSec + Number(oauth2.refresh_token_expires_in || 0);

    return { oauth1, oauth2 };
}

/** 轻量加载项目根目录 .env（不引入 dotenv 依赖），已存在的环境变量优先 */
function loadDotEnv(path = './.env') {
    if (!fs.existsSync(path)) return;
    const content = fs.readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) process.env[key] = val;
    }
}

async function main() {
    loadDotEnv();
    const username = (process.env.GARMIN_GLOBAL_USERNAME_2 || process.env.GARMIN_GLOBAL_USERNAME || '').trim();
    const password = (process.env.GARMIN_GLOBAL_PASSWORD_2 || process.env.GARMIN_GLOBAL_PASSWORD || '').trim();
    if (!username || !password) {
        console.error('❌ 请提供国际区账号密码：GARMIN_GLOBAL_USERNAME_2 / GARMIN_GLOBAL_PASSWORD_2');
        process.exit(1);
    }

    console.log(`=== 导出佳明国际区 Token（账号: ${username}）===`);
    console.log('提示：请确保当前是住宅网络/家庭宽带出口，不要用机房/VPS 网络。');

    // 全程裸 https：Cloudflare 对 @gooin/garmin-connect 的 axios 指纹在 sso/connectapi 上
    // 做 301 自循环/401 软拦截，而 Node 裸 https 可正常通过。只发一次登录 POST，降低触发限流。
    let ticket: string;
    try {
        ticket = await loginViaBareHttps(username, password);
        console.log('✅ 登录成功，拿到 ServiceTicket，开始 OAuth 交换...');
    } catch (err: any) {
        const msg = String(err?.message ?? err);
        if (/\b429\b|too many requests|rate limit/i.test(msg)) {
            console.error('❌ 登录被 429 拦截。这是 Cloudflare 的账号级/IP 级封锁，不是频率限制：');
            console.error('   1) 换一个家庭宽带出口（或等目前这个出口冷却）；');
            console.error('   2) 该账号若之前被反复登录，会进入 48-72h 账号级封锁，等封锁解除后再试；');
            console.error('   3) 期间不要反复重跑，每次重试都会续期封锁。');
            process.exit(2);
        }
        console.error('❌ 登录失败:', msg);
        process.exit(2);
    }

    let token: { oauth1: any; oauth2: any };
    try {
        token = await exchangeTicketForTokens(ticket);
    } catch (err: any) {
        console.error('❌ OAuth 交换失败:', String(err?.message ?? err));
        process.exit(2);
    }
    const payload = { sessionUser: username, region: 'GLOBAL', token };

    const outDir = './db';
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = `${outDir}/global_token.json`;
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    console.log('');
    console.log(`✅ OAuth token 导出成功，已写入 ${outPath}`);
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
