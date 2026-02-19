/**
 * Garmin CN SSO MFA 登录流程
 *
 * 流程:
 *   1. requestMfaCode: POST 用户名密码 → 佳明发验证码邮件 → 返回 CSRF token + cookies
 *   2. verifyMfaCode: POST 验证码 + CSRF → 获取 ServiceTicket
 *   3. exchangeTokens: 用 ServiceTicket 交换 OAuth tokens → 保存到 DB
 */

import axios from 'axios';
import * as qs from 'qs';
import { GARMIN_URL_DEFAULT, UA_DEFAULT } from '../constant';
import { initDB, saveSessionToDB, updateSessionToDB, getSessionFromDB } from '../utils/sqlite';
import { sendBarkNotification } from '../utils/garmin_common';

const core = require('@actions/core');

// MFA 中间状态存储 (用于在两个 workflow 之间传递 CSRF + cookies)
export interface MfaState {
    csrf: string;
    cookies: string;
    timestamp: number;
}

const SSO_BASE = 'https://sso.garmin.cn/sso';

const COMMON_PARAMS = {
    'clientId': 'GarminConnect',
    'consumeServiceTicket': 'false',
    'createAccountShown': 'true',
    'cssUrl': GARMIN_URL_DEFAULT.CSS_URL,
    'displayNameShown': 'false',
    'embedWidget': 'false',
    'gauthHost': SSO_BASE,
    'generateExtraServiceTicket': 'true',
    'generateTwoExtraServiceTickets': 'true',
    'generateNoServiceTicket': 'false',
    'globalOptInChecked': 'false',
    'globalOptInShown': 'true',
    'id': 'gauth-widget',
    'initialFocus': 'true',
    'locale': 'zh_CN',
    'locationPromptShown': 'true',
    'mobile': 'false',
    'openCreateAccount': 'false',
    'redirectAfterAccountCreationUrl': GARMIN_URL_DEFAULT.MODERN_URL,
    'redirectAfterAccountLoginUrl': GARMIN_URL_DEFAULT.MODERN_URL,
    'rememberMeChecked': 'false',
    'rememberMeShown': 'true',
    'service': GARMIN_URL_DEFAULT.MODERN_URL,
    'source': GARMIN_URL_DEFAULT.SIGNIN_URL,
    'webhost': GARMIN_URL_DEFAULT.MODERN_URL,
};

/**
 * 从 HTML 响应中提取 CSRF token
 */
function extractCsrf(html: string): string | null {
    // 尝试多种匹配方式
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

/**
 * 从 HTML 或 URL 中提取 ServiceTicket
 */
function extractTicket(html: string): string | null {
    const patterns = [
        /ticket=([A-Z0-9-]+)/,
        /ServiceTicket=([A-Z0-9-]+)/i,
        /var\s+response_url\s*=\s*['"]([^'"]*ticket=[^'"]*)['"]/,
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) return match[1];
    }
    return null;
}

/**
 * 合并 Set-Cookie headers 为 cookie 字符串
 */
function mergeCookies(existingCookies: string, setCookieHeaders: string | string[] | undefined): string {
    if (!setCookieHeaders) return existingCookies;
    const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    const cookieMap = new Map<string, string>();

    // 解析现有 cookies
    if (existingCookies) {
        existingCookies.split(';').forEach(c => {
            const [key, ...val] = c.trim().split('=');
            if (key) cookieMap.set(key.trim(), val.join('=').trim());
        });
    }

    // 合并新 cookies
    headers.forEach(h => {
        const parts = h.split(';')[0].trim().split('=');
        if (parts[0]) {
            cookieMap.set(parts[0].trim(), parts.slice(1).join('=').trim());
        }
    });

    return Array.from(cookieMap.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Step 1: 发送用户名密码，触发佳明发送验证码邮件
 * @returns MfaState 包含 CSRF token 和 cookies，供 verifyMfaCode 使用
 */
export async function requestMfaCode(username: string, password: string): Promise<MfaState> {
    console.log('[MFA] Step 1: 发送登录请求，触发验证码邮件...');

    // 1.1 先获取登录页面的 CSRF token
    const signinUrl = `${SSO_BASE}/signin?${qs.stringify(COMMON_PARAMS)}`;
    const pageResp = await axios.get(signinUrl, {
        headers: { 'User-Agent': UA_DEFAULT },
        maxRedirects: 0,
        validateStatus: (s: number) => s < 400,
    });

    let cookies = mergeCookies('', pageResp.headers['set-cookie']);
    let csrf = extractCsrf(pageResp.data);

    if (!csrf) {
        throw new Error('[MFA] 无法从登录页面提取 CSRF token');
    }
    console.log('[MFA] 获取到 CSRF token');

    // 1.2 POST 用户名密码
    const loginResp = await axios.post(
        signinUrl,
        qs.stringify({
            'username': username,
            'password': password,
            'embed': 'true',
            '_csrf': csrf,
        }),
        {
            headers: {
                'User-Agent': UA_DEFAULT,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookies,
                'Origin': 'https://sso.garmin.cn',
                'Referer': signinUrl,
            },
            maxRedirects: 0,
            validateStatus: (s: number) => s < 500,
        },
    );

    cookies = mergeCookies(cookies, loginResp.headers['set-cookie']);

    // 检查响应：如果包含 MFA 表单，说明需要验证码
    const responseHtml = typeof loginResp.data === 'string' ? loginResp.data : '';

    // 检查是否直接登录成功（不需要 MFA）
    const directTicket = extractTicket(responseHtml);
    if (directTicket) {
        console.log('[MFA] 账号无需 MFA，直接登录成功');
        // 此处不应该发生在 ECG 开启的账号，但做个兼容
        throw new Error(`NO_MFA_NEEDED:${directTicket}`);
    }

    // 从 MFA 页面提取新的 CSRF token
    const mfaCsrf = extractCsrf(responseHtml);
    if (mfaCsrf) {
        csrf = mfaCsrf;
    }

    // 检查是否包含 MFA 相关内容
    const isMfaPage = responseHtml.includes('verifyMFA') ||
        responseHtml.includes('mfa-code') ||
        responseHtml.includes('MFA') ||
        responseHtml.includes('verification') ||
        responseHtml.includes('验证码');

    if (!isMfaPage) {
        console.error('[MFA] 响应不包含 MFA 页面，可能是密码错误或其他问题');
        console.error('[MFA] 响应状态码:', loginResp.status);
        // 保存部分响应用于调试
        console.error('[MFA] 响应内容(前500字符):', responseHtml.substring(0, 500));
        throw new Error('[MFA] 登录失败：未出现 MFA 验证页面，请检查用户名密码是否正确');
    }

    console.log('[MFA] ✅ 已触发验证码邮件发送，请检查邮箱');

    return {
        csrf,
        cookies,
        timestamp: Date.now(),
    };
}

/**
 * Step 2: 提交 MFA 验证码，获取 ServiceTicket
 * @param code 用户从邮件中获取的 6 位验证码
 * @param state 从 requestMfaCode 返回的中间状态
 * @returns ServiceTicket
 */
export async function verifyMfaCode(code: string, state: MfaState): Promise<string> {
    console.log('[MFA] Step 2: 提交验证码...');

    // 检查 state 是否过期（30分钟有效期）
    const elapsed = Date.now() - state.timestamp;
    if (elapsed > 30 * 60 * 1000) {
        throw new Error('[MFA] 验证码已过期（超过30分钟），请重新请求');
    }

    const verifyUrl = `${SSO_BASE}/verifyMFA/loginEnterMfaCode`;
    const verifyResp = await axios.post(
        verifyUrl,
        qs.stringify({
            'mfa-code': code,
            '_csrf': state.csrf,
            'fromPage': 'setupEnterMfaCode',
            'embed': 'true',
        }),
        {
            headers: {
                'User-Agent': UA_DEFAULT,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': state.cookies,
                'Origin': 'https://sso.garmin.cn',
                'Referer': `${SSO_BASE}/verifyMFA/loginEnterMfaCode`,
            },
            maxRedirects: 0,
            validateStatus: (s: number) => s < 500,
        },
    );

    const responseHtml = typeof verifyResp.data === 'string' ? verifyResp.data : '';

    // 尝试从响应或重定向 URL 中提取 ticket
    let ticket = extractTicket(responseHtml);

    // 如果从 body 没找到，检查 Location header
    if (!ticket && verifyResp.headers['location']) {
        ticket = extractTicket(verifyResp.headers['location']);
    }

    if (!ticket) {
        console.error('[MFA] 无法获取 ServiceTicket');
        console.error('[MFA] 响应状态:', verifyResp.status);
        console.error('[MFA] 响应内容(前500字符):', responseHtml.substring(0, 500));
        throw new Error('[MFA] 验证码验证失败，请检查验证码是否正确或已过期');
    }

    console.log('[MFA] ✅ 验证码验证成功，获取到 ServiceTicket');
    return ticket;
}

/**
 * Step 3: 用 ServiceTicket 登录 GarminConnect 并保存 token
 * @param ticket ServiceTicket
 */
export async function exchangeAndSaveToken(ticket: string): Promise<void> {
    console.log('[MFA] Step 3: 用 ServiceTicket 交换 OAuth tokens...');

    const { GarminConnect } = require('@gooin/garmin-connect');

    // 创建一个新的 client 实例，使用 ticket 完成登录
    // GarminConnect 库的 login 最终也是通过 ticket 获取 token
    // 我们这里需要利用 ticket 来获取 OAuth tokens

    // 方法: 用 ticket URL 访问 connect.garmin.cn/modern/?ticket=xxx 来建立 session
    const ticketUrl = `${GARMIN_URL_DEFAULT.MODERN_URL}?ticket=${ticket}`;

    const ticketResp = await axios.get(ticketUrl, {
        headers: { 'User-Agent': UA_DEFAULT },
        maxRedirects: 5,
        validateStatus: (s: number) => s < 500,
    });

    // 从响应中提取 session cookies
    const sessionCookies = mergeCookies('', ticketResp.headers['set-cookie']);

    // 由于 @gooin/garmin-connect 库不直接支持 ticket 登录，
    // 我们需要通过其内部 HttpClient 来设置 session
    // 替代方案: 使用库的 login 流程但传入预认证的 cookies

    // 实际使用时，最简单的方法是：
    // 用 GarminConnect 直接 login()，但是我们已经通过 MFA 获得了 ServiceTicket
    // 库的 login 内部流程也是: 密码 → ticket → OAuth tokens
    // 我们可以尝试直接创建 client 并调用其内部的 token 交换方法

    // 最可靠的方式：用 GarminConnect 实例化后，直接走 login 流程
    // 由于 MFA 已通过，再次 login 应该能成功（利用 cookies）
    // 但更安全的方式是保存 ticket 并让 client 使用

    console.log('[MFA] 尝试使用 ServiceTicket 获取 OAuth tokens...');

    // 使用 GarminConnect 的底层方法来完成 token 交换
    const GCClient = new GarminConnect({}, 'garmin.cn');

    try {
        // 尝试通过 client 的内部方法完成 ticket 交换
        // 如果 client 支持 exchangeToken 或类似方法
        if (typeof GCClient.client?.exchangeToken === 'function') {
            await GCClient.client.exchangeToken(ticket);
        } else {
            // 备用方案: 直接用 axios 完成 OAuth 交换
            // Step 3a: 用 ticket 获取 OAuth1 consumer token
            const oauth1Url = `https://connect.garmin.cn/modern/di-oauth/exchange/user/2.0`;
            const oauth1Resp = await axios.post(
                oauth1Url,
                qs.stringify({ 'ticket': ticket }),
                {
                    headers: {
                        'User-Agent': UA_DEFAULT,
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    maxRedirects: 5,
                    validateStatus: (s: number) => s < 500,
                },
            );

            if (oauth1Resp.status !== 200 || !oauth1Resp.data) {
                throw new Error(`OAuth1 交换失败: status=${oauth1Resp.status}`);
            }

            console.log('[MFA] ✅ 获取到 OAuth tokens');

            // 保存 tokens 到数据库
            await initDB();
            const tokenData = oauth1Resp.data;
            const existingSession = await getSessionFromDB('CN');

            if (existingSession) {
                await updateSessionToDB('CN', tokenData);
            } else {
                await saveSessionToDB('CN', tokenData);
            }
            console.log('[MFA] ✅ Token 已保存到数据库');
            return;
        }

        // 如果通过 client 方法成功，保存 token
        const token = GCClient.exportToken();
        await initDB();
        const existingSession = await getSessionFromDB('CN');
        if (existingSession) {
            await updateSessionToDB('CN', token);
        } else {
            await saveSessionToDB('CN', token);
        }
        console.log('[MFA] ✅ Token 已保存到数据库');

    } catch (e) {
        console.error('[MFA] Token 交换失败:', e.message);
        throw e;
    }
}

/**
 * MFA 状态写入到临时文件（用于跨 workflow 传递）
 */
export function saveMfaState(state: MfaState): void {
    const fs = require('fs');
    const statePath = './db/mfa_state.json';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(`[MFA] 状态已保存到 ${statePath}`);
}

/**
 * 从临时文件加载 MFA 状态
 */
export function loadMfaState(): MfaState {
    const fs = require('fs');
    const statePath = './db/mfa_state.json';
    if (!fs.existsSync(statePath)) {
        throw new Error('[MFA] 未找到 MFA 状态文件，请先运行 request_mfa');
    }
    const data = fs.readFileSync(statePath, 'utf-8');
    const state = JSON.parse(data) as MfaState;

    // 检查是否过期
    const elapsed = Date.now() - state.timestamp;
    if (elapsed > 30 * 60 * 1000) {
        throw new Error('[MFA] MFA 状态已过期（超过30分钟），请重新运行 request_mfa');
    }

    return state;
}

/**
 * 清理 MFA 状态文件
 */
export function cleanMfaState(): void {
    const fs = require('fs');
    const statePath = './db/mfa_state.json';
    if (fs.existsSync(statePath)) {
        fs.unlinkSync(statePath);
        console.log('[MFA] 临时状态文件已清理');
    }
}
