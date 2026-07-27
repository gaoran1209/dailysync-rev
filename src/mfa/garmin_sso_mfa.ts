/**
 * 佳明国区 SSO 的两个原语：
 *   1. ssoPasswordLogin  —— 账号密码换 ServiceTicket（无 MFA 的账号才能走通）
 *   2. exchangeAndSaveToken —— 用 ServiceTicket 换 OAuth1/OAuth2 并落库
 *
 * 开了 ECG 的账号（账号2）强制邮箱验证码，走不通 ①，改由
 * src/service/account2_auth.ts 用 Playwright + IMAP 完成，拿到 ticket 后同样调 ②。
 */

import axios from 'axios';
import * as qs from 'qs';
import { GARMIN_URL_DEFAULT, HTTP_TIMEOUT_MS, UA_DEFAULT } from '../constant';
import { getSessionFromDB, initDB, saveSessionToDB, updateSessionToDB } from '../utils/sqlite';

const SSO_BASE = 'https://sso.garmin.cn/sso';
// 关键: ticket 的 service 必须与 @gooin/garmin-connect 库 OAuth1 交换时的
// login-url (sso/embed) 一致，否则 getOauth1Token 会失败
const SSO_EMBED = 'https://sso.garmin.cn/sso/embed';

const COMMON_PARAMS = {
    id: 'gauth-widget',
    embedWidget: 'true',
    clientId: 'GarminConnect',
    locale: 'en',
    gauthHost: SSO_EMBED,
    service: SSO_EMBED,
    source: SSO_EMBED,
    redirectAfterAccountLoginUrl: SSO_EMBED,
    redirectAfterAccountCreationUrl: SSO_EMBED,
};

export function getGarminCnSigninUrl(): string {
    return `${SSO_BASE}/signin?${qs.stringify(COMMON_PARAMS)}`;
}

function extractCsrf(html: string): string | null {
    const patterns = [
        /name="_csrf"\s+value="([^"]+)"/,
        /name='_csrf'\s+value='([^']+)'/,
        /<input[^>]*name="_csrf"[^>]*value="([^"]+)"/,
        /<input[^>]*value="([^"]+)"[^>]*name="_csrf"/,
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) return match[1];
    }
    return null;
}

/** 从 HTML 或 URL 中提取 ServiceTicket */
export function extractTicket(input: string): string | null {
    if (!input) return null;

    const directPatterns = [
        /(?:[?&]|^)ticket=([^&"'\s<>]+)/i,
        /ServiceTicket=([^&"'\s<>]+)/i,
    ];
    for (const pattern of directPatterns) {
        const match = input.match(pattern);
        if (match?.[1]) {
            try {
                return decodeURIComponent(match[1]);
            } catch {
                return match[1];
            }
        }
    }

    // 常见场景: HTML 中有 var response_url = "https://...?...&ticket=..."
    const responseUrlMatch = input.match(/var\s+response_url\s*=\s*['"]([^'"]+)['"]/i);
    if (responseUrlMatch?.[1]) {
        const responseUrl = responseUrlMatch[1];
        try {
            const url = new URL(responseUrl);
            const ticket = url.searchParams.get('ticket') || url.searchParams.get('ServiceTicket');
            if (ticket) return ticket;
        } catch {
            const fallback = responseUrl.match(/(?:[?&]|^)ticket=([^&"'\s<>]+)/i);
            if (fallback?.[1]) return fallback[1];
        }
    }

    return null;
}

function mergeCookies(existingCookies: string, setCookieHeaders: string | string[] | undefined): string {
    if (!setCookieHeaders) return existingCookies;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const cookieMap = new Map<string, string>();

    if (existingCookies) {
        existingCookies.split(';').forEach(c => {
            const [key, ...val] = c.trim().split('=');
            if (key) cookieMap.set(key.trim(), val.join('=').trim());
        });
    }
    headers.forEach(h => {
        const parts = h.split(';')[0].trim().split('=');
        if (parts[0]) {
            cookieMap.set(parts[0].trim(), parts.slice(1).join('=').trim());
        }
    });

    return Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

export type SsoPasswordLoginResult =
    | { outcome: 'ticket'; ticket: string }
    | { outcome: 'mfa_required' }
    | { outcome: 'rejected'; detail: string };

/** 页面里出现这些标记才说明佳明真的进入了验证码环节 */
function looksLikeMfaPage(html: string, location: string): boolean {
    return /verifyMFA/i.test(location)
        || /verifyMFA|mfa-code|one[-\s]?time[-\s]?code/i.test(html);
}

/**
 * 用账号密码走国区 SSO。
 *
 * 三种结果必须分清楚——早期版本把「没拿到 ticket」一律当成需要验证码，结果密码
 * 错误也会被报成「需要邮箱验证码」，既误导人，又会让人反复重试去撞佳明的登录失败计数。
 */
export async function ssoPasswordLogin(username: string, password: string): Promise<SsoPasswordLoginResult> {
    console.log('[SSO] 用账号密码发起国区登录...');

    // 与库的 login 流程一致，先 GET sso/embed 建立 CAS 初始 cookies
    const embedResp = await axios.get(
        `${SSO_EMBED}?${qs.stringify({ clientId: 'GarminConnect', locale: 'en', service: GARMIN_URL_DEFAULT.MODERN_URL })}`,
        {
            headers: { 'User-Agent': UA_DEFAULT },
            maxRedirects: 5,
            timeout: HTTP_TIMEOUT_MS,
            validateStatus: (s: number) => s < 400,
        },
    );
    let cookies = mergeCookies('', embedResp.headers['set-cookie']);

    const signinUrl = getGarminCnSigninUrl();
    const pageResp = await axios.get(signinUrl, {
        headers: { 'User-Agent': UA_DEFAULT, Cookie: cookies },
        maxRedirects: 0,
        timeout: HTTP_TIMEOUT_MS,
        validateStatus: (s: number) => s < 400,
    });

    cookies = mergeCookies(cookies, pageResp.headers['set-cookie']);
    const csrf = extractCsrf(pageResp.data);
    if (!csrf) {
        throw new Error('[SSO] 无法从登录页面提取 CSRF token（佳明可能改版了登录页）');
    }

    const loginResp = await axios.post(
        signinUrl,
        qs.stringify({ username, password, embed: 'true', _csrf: csrf }),
        {
            headers: {
                'User-Agent': UA_DEFAULT,
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookies,
                Origin: 'https://sso.garmin.cn',
                Referer: signinUrl,
            },
            maxRedirects: 0,
            timeout: HTTP_TIMEOUT_MS,
            validateStatus: (s: number) => s < 500,
        },
    );

    const responseHtml = typeof loginResp.data === 'string' ? loginResp.data : '';
    const location = String(loginResp.headers['location'] ?? '');
    const ticket = extractTicket(responseHtml) ?? extractTicket(location);
    if (ticket) {
        console.log('[SSO] 登录成功，已拿到 ServiceTicket（该账号无需 MFA）');
        return { outcome: 'ticket', ticket };
    }

    if (looksLikeMfaPage(responseHtml, location)) {
        console.log('[SSO] 佳明要求邮箱验证码，密码登录这条路走不通');
        return { outcome: 'mfa_required' };
    }

    // 既没有 ticket、也没有验证码页面：绝大多数情况是账号密码不对，或者佳明改了登录页
    const snippet = responseHtml.replace(/\s+/g, ' ').trim().slice(0, 200);
    console.log(`[SSO] 登录被拒，HTTP ${loginResp.status}`);
    return { outcome: 'rejected', detail: snippet || `HTTP ${loginResp.status}` };
}

/**
 * 用 ServiceTicket 换 OAuth1/OAuth2 并落库。
 *
 * 注意: ServiceTicket 是一次性的。绝不能先访问 modern/?ticket= 页面，
 * 否则 ticket 被 CAS 消费，后面的 OAuth1 交换必然失败。
 */
export async function exchangeAndSaveToken(
    ticket: string,
    options: { region: 'CN' | 'GLOBAL'; sessionUser: string },
): Promise<void> {
    const { GarminConnect } = require('@gooin/garmin-connect');
    const { region, sessionUser } = options;

    console.log('[SSO] 用 ServiceTicket 交换 OAuth token...');
    const GCClient = new GarminConnect({}, region === 'CN' ? 'garmin.cn' : 'garmin.com');

    await GCClient.client.fetchOauthConsumer();
    const oauth1Res = await GCClient.client.getOauth1Token(ticket);
    await GCClient.client.exchange(oauth1Res);
    const token = GCClient.exportToken();

    await initDB();
    const existingSession = await getSessionFromDB(region, sessionUser);
    if (existingSession) {
        await updateSessionToDB(region, token, sessionUser);
    } else {
        await saveSessionToDB(region, token, sessionUser);
    }
    console.log(`[SSO] ✅ ${region} token (OAuth1 & OAuth2) 已保存到数据库`);
}
