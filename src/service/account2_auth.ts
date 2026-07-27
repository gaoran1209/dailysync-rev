import { chromium, type BrowserContext, type Page } from 'playwright';
import { exchangeAndSaveToken, extractTicket } from '../mfa/garmin_sso_mfa';
import { getGaminCNClient } from '../utils/garmin_cn';
import { sendBarkNotification } from '../utils/garmin_common';
import { fetchGarminMfaCode } from './mail_code_fetcher';
import {
    getAccountAuthState,
    getSessionFromDB,
    initDB,
    markAccountAuthAwaitingCode,
    markAccountAuthError,
    markAccountAuthReady,
    markAccountAuthReauthRequired,
} from '../utils/sqlite';
import { getAccount2AuthConfig } from './config';

export interface Account2StatusSnapshot {
    accountKey: string;
    status: 'ready' | 'awaiting_code' | 'reauth_required' | 'error';
    hasStoredCnSession: boolean;
    lastSuccessAt: number | null;
    lastError: string | null;
    lastErrorAt: number | null;
    updatedAt: number | null;
    pendingSince: number | null;
    currentUrl: string | null;
}

export interface Account2ActionResponse {
    status: Account2StatusSnapshot['status'];
    message: string;
    account: Account2StatusSnapshot;
}

interface PendingLoginState {
    page: Page;
    startedAt: number;
}

function sanitizeMessage(message: string): string {
    return message.replace(/\s+/g, ' ').trim().slice(0, 240);
}

export class Account2AuthService {
    private readonly config = getAccount2AuthConfig();
    private contextPromise: Promise<BrowserContext> | null = null;
    private pendingLogin: PendingLoginState | null = null;
    private autoLoginInFlight: Promise<Account2ActionResponse> | null = null;

    get canAutoLogin(): boolean {
        return Boolean(this.config.mail);
    }

    /**
     * 全自动登录：发起 Playwright 登录 → 从邮箱自动读取 MFA 验证码 → 提交。
     * 单飞：并发调用共享同一次登录流程。
     */
    async autoLogin(): Promise<Account2ActionResponse> {
        if (this.autoLoginInFlight) {
            return this.autoLoginInFlight;
        }
        this.autoLoginInFlight = this.doAutoLogin().finally(() => {
            this.autoLoginInFlight = null;
        });
        return this.autoLoginInFlight;
    }

    private async doAutoLogin(): Promise<Account2ActionResponse> {
        const mail = this.config.mail;
        if (!mail) {
            return {
                status: 'reauth_required',
                message: '未配置 MAIL_IMAP_PASSWORD，无法自动读取验证码，请先在 .env 里填 163 授权码',
                account: await this.getStatus(),
            };
        }

        // 记录发起时间，只接受这之后收到的验证码邮件
        const requestedAt = Date.now();
        console.log('[Account2Auth] 自动登录: 发起 Garmin CN 登录...');
        const startResult = await this.startLogin();
        if (startResult.status === 'ready') {
            await sendBarkNotification('Garmin CN 自动登录成功', '无需验证码，token 已刷新');
            return startResult;
        }
        if (startResult.status !== 'awaiting_code') {
            await sendBarkNotification('Garmin CN 自动登录失败', startResult.message);
            return startResult;
        }

        console.log('[Account2Auth] 自动登录: 等待邮箱验证码...');
        let code: string;
        try {
            code = await fetchGarminMfaCode(mail, { sinceMs: requestedAt });
        } catch (err) {
            const message = sanitizeMessage(`自动读取验证码失败: ${err.message}`);
            await markAccountAuthError(this.config.accountKey, message);
            await sendBarkNotification('Garmin CN 自动登录失败', message);
            return {
                status: 'error',
                message,
                account: await this.getStatus(),
            };
        }

        console.log('[Account2Auth] 自动登录: 已取得验证码，提交中...');
        const verifyResult = await this.verifyCode(code);
        if (verifyResult.status === 'ready') {
            await sendBarkNotification('Garmin CN 自动登录成功', '已自动完成邮箱验证码登录，token 已保存');
        } else {
            await sendBarkNotification('Garmin CN 自动登录失败', verifyResult.message);
        }
        return verifyResult;
    }

    /** 释放常驻的 Chromium。CLI 收尾必须调，否则进程不会自然退出。 */
    async close(): Promise<void> {
        if (!this.contextPromise) return;
        const contextPromise = this.contextPromise;
        this.contextPromise = null;
        this.pendingLogin = null;
        await contextPromise.then(ctx => ctx.close()).catch(() => undefined);
    }

    async getStatus(): Promise<Account2StatusSnapshot> {
        await initDB();
        const state = await getAccountAuthState(this.config.accountKey);
        const hasStoredCnSession = Boolean(await getSessionFromDB('CN', this.config.cn.sessionUser).catch(() => undefined));
        const currentUrl = this.pendingLogin && !this.pendingLogin.page.isClosed()
            ? this.pendingLogin.page.url()
            : null;

        if (this.pendingLogin && !this.pendingLogin.page.isClosed()) {
            return {
                accountKey: this.config.accountKey,
                status: 'awaiting_code',
                hasStoredCnSession,
                lastSuccessAt: state?.lastSuccessAt ?? null,
                lastError: state?.lastError ?? null,
                lastErrorAt: state?.lastErrorAt ?? null,
                updatedAt: state?.updatedAt ?? this.pendingLogin.startedAt,
                pendingSince: this.pendingLogin.startedAt,
                currentUrl,
            };
        }

        if (state) {
            return {
                accountKey: this.config.accountKey,
                status: state.status,
                hasStoredCnSession,
                lastSuccessAt: state.lastSuccessAt,
                lastError: state.lastError,
                lastErrorAt: state.lastErrorAt,
                updatedAt: state.updatedAt,
                pendingSince: null,
                currentUrl,
            };
        }

        return {
            accountKey: this.config.accountKey,
            status: hasStoredCnSession ? 'ready' : 'reauth_required',
            hasStoredCnSession,
            lastSuccessAt: null,
            lastError: null,
            lastErrorAt: null,
            updatedAt: null,
            pendingSince: null,
            currentUrl,
        };
    }

    // 内部使用：由 autoLogin() 调用发起国区登录（Playwright 提交账号密码）
    private async startLogin(): Promise<Account2ActionResponse> {
        try {
            const page = await this.openFreshPage();
            // 用与 @gooin/garmin-connect 库一致的参数，确保 ticket 的 service 匹配 OAuth exchange 的 login-url
            const ssoEmbed = 'https://sso.garmin.cn/sso/embed';
            const signinUrl = `https://sso.garmin.cn/sso/signin?clientId=GarminConnect&locale=en&id=gauth-widget&embedWidget=true&gauthHost=${encodeURIComponent(ssoEmbed)}&service=${encodeURIComponent(ssoEmbed)}&source=${encodeURIComponent(ssoEmbed)}&redirectAfterAccountLoginUrl=${encodeURIComponent(ssoEmbed)}&redirectAfterAccountCreationUrl=${encodeURIComponent(ssoEmbed)}`;
            await page.goto(signinUrl, {
                waitUntil: 'domcontentloaded',
                timeout: 60_000,
            });
            await this.fillFirstVisible(page, [
                'input[name="username"]',
                'input#username',
                'input[type="email"]',
                'input[autocomplete="username"]',
            ], this.config.cn.username);
            await this.fillFirstVisible(page, [
                'input[name="password"]',
                'input#password',
                'input[type="password"]',
                'input[autocomplete="current-password"]',
            ], this.config.cn.password);
            await this.submitForm(page);

            const directTicket = await this.extractTicketFromPage(page);
            if (directTicket) {
                return await this.finalizeSuccessfulLogin(directTicket, 'Garmin CN 已直接登录并刷新 token');
            }

            if (await this.isMfaChallengePage(page)) {
                this.pendingLogin = {
                    page,
                    startedAt: Date.now(),
                };
                await markAccountAuthAwaitingCode(this.config.accountKey);
                return {
                    status: 'awaiting_code',
                    message: '验证码邮件已发送，等待从邮箱读取验证码',
                    account: await this.getStatus(),
                };
            }

            const snippet = await this.getPageSnippet(page);
            await markAccountAuthError(this.config.accountKey, snippet);
            return {
                status: 'error',
                message: `未能识别 Garmin 登录状态：${snippet}`,
                account: await this.getStatus(),
            };
        } catch (err) {
            const message = sanitizeMessage(err.message ?? 'Garmin 登录发起失败');
            await this.disposePendingPage();
            await markAccountAuthError(this.config.accountKey, message);
            return {
                status: 'error',
                message,
                account: await this.getStatus(),
            };
        }
    }

    // 内部使用：由 autoLogin() 在拿到邮箱验证码后调用提交
    private async verifyCode(rawCode: string): Promise<Account2ActionResponse> {
        const code = rawCode.trim().replace(/[^\dA-Za-z]/g, '');
        if (!code) {
            return {
                status: 'awaiting_code',
                message: '请先填写邮件中的验证码',
                account: await this.getStatus(),
            };
        }

        if (!this.pendingLogin || this.pendingLogin.page.isClosed()) {
            await markAccountAuthReauthRequired(this.config.accountKey, '没有可用的待验证登录流程，请重新发起登录');
            return {
                status: 'reauth_required',
                message: '当前没有待验证登录流程，请重新点击“开始 Garmin 国区登录”',
                account: await this.getStatus(),
            };
        }

        try {
            const page = this.pendingLogin.page;
            await this.fillFirstVisible(page, [
                'input[name="mfa-code"]',
                'input[name="mfaCode"]',
                'input[id*="mfa"]',
                'input[autocomplete="one-time-code"]',
            ], code);
            await this.maybeTrustCurrentBrowser(page);

            // 从 POST 响应体中截取 ticket，不让浏览器导航消费它
            const ticket = await this.submitAndCaptureTicket(page);
            if (ticket) {
                return await this.finalizeSuccessfulLogin(ticket, 'Garmin CN 登录成功，Token 已保存到数据库');
            }

            // 没有截取到 ticket，可能验证码错误，检查页面状态
            if (await this.isMfaChallengePage(page)) {
                const message = '验证码错误或已过期，请检查邮件中的最新验证码后重试';
                await markAccountAuthAwaitingCode(this.config.accountKey, message);
                return {
                    status: 'awaiting_code',
                    message,
                    account: await this.getStatus(),
                };
            }

            const snippet = await this.getPageSnippet(page);
            await markAccountAuthError(this.config.accountKey, snippet);
            return {
                status: 'error',
                message: `验证码提交后未能识别登录结果：${snippet}`,
                account: await this.getStatus(),
            };
        } catch (err) {
            const message = sanitizeMessage(err.message ?? '验证码验证失败');
            await markAccountAuthError(this.config.accountKey, message);
            return {
                status: 'error',
                message,
                account: await this.getStatus(),
            };
        }
    }

    private async getContext(): Promise<BrowserContext> {
        if (!this.contextPromise) {
            this.contextPromise = chromium.launchPersistentContext(this.config.playwrightProfileDir, {
                headless: this.config.playwrightHeadless,
                viewport: { width: 1440, height: 1024 },
                args: [
                    '--no-sandbox',
                    '--disable-dev-shm-usage',
                ],
            });
        }
        return this.contextPromise;
    }

    private async openFreshPage(): Promise<Page> {
        const context = await this.getContext();
        await this.disposePendingPage();
        for (const page of context.pages()) {
            if (!page.isClosed()) {
                await page.close().catch(() => undefined);
            }
        }
        return await context.newPage();
    }

    private async disposePendingPage() {
        if (this.pendingLogin?.page && !this.pendingLogin.page.isClosed()) {
            await this.pendingLogin.page.close().catch(() => undefined);
        }
        this.pendingLogin = null;
    }

    private async fillFirstVisible(page: Page, selectors: string[], value: string) {
        for (const selector of selectors) {
            const locator = page.locator(selector).first();
            const count = await locator.count().catch(() => 0);
            if (!count) {
                continue;
            }
            const visible = await locator.isVisible().catch(() => false);
            if (!visible) {
                continue;
            }
            await locator.fill(value);
            return;
        }
        throw new Error(`未找到可填写的输入框: ${selectors.join(', ')}`);
    }

    private async clickFirstVisible(page: Page, selectors: string[]) {
        for (const selector of selectors) {
            const locator = page.locator(selector).first();
            const count = await locator.count().catch(() => 0);
            if (!count) {
                continue;
            }
            const visible = await locator.isVisible().catch(() => false);
            if (!visible) {
                continue;
            }
            await locator.click();
            return;
        }
        throw new Error(`未找到可点击的按钮: ${selectors.join(', ')}`);
    }

    /**
     * 提交 MFA 表单并从 POST 响应中截取 ticket，阻止浏览器导航消费它。
     * Ticket 是一次性的，浏览器一旦导航到 ticket URL 就会被消费。
     */
    private async submitAndCaptureTicket(page: Page): Promise<string | null> {
        let capturedTicket: string | null = null;

        // 拦截包含 ticket 的导航请求，提取 ticket 后阻止浏览器消费
        await page.route('**/*', (route) => {
            const url = route.request().url();
            const ticket = extractTicket(url);
            if (ticket && !capturedTicket) {
                capturedTicket = ticket;
                route.abort();
                return;
            }
            route.continue();
        });

        // 同时监听 POST 响应体中的 ticket（embed 模式下 ticket 在 response_url 中）
        const responsePromise = page.waitForResponse(
            (resp) => resp.request().method() === 'POST' && resp.url().includes('/sso/'),
            { timeout: 30_000 },
        ).catch(() => null);

        try {
            await this.clickFirstVisible(page, [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("登录")',
                'button:has-text("Sign In")',
                'button:has-text("继续")',
                'button:has-text("提交")',
            ]);
        } catch {
            await page.keyboard.press('Enter').catch(() => undefined);
        }

        const response = await responsePromise;
        if (!capturedTicket && response) {
            try {
                const body = await response.text();
                capturedTicket = extractTicket(body);
            } catch {
                // response body may not be available if aborted
            }
        }

        // 等一下让拦截有机会触发
        await page.waitForTimeout(2_000);

        // 清除路由拦截
        await page.unroute('**/*').catch(() => undefined);

        // 如果还没找到，从当前页面内容再试一次
        if (!capturedTicket) {
            capturedTicket = await this.extractTicketFromPage(page);
        }

        return capturedTicket;
    }

    private async submitForm(page: Page) {
        const navigationPromise = page.waitForNavigation({
            waitUntil: 'domcontentloaded',
            timeout: 15_000,
        }).catch(() => null);

        try {
            await this.clickFirstVisible(page, [
                'button[type="submit"]',
                'input[type="submit"]',
                'button:has-text("登录")',
                'button:has-text("Sign In")',
                'button:has-text("继续")',
                'button:has-text("提交")',
            ]);
        } catch {
            await page.keyboard.press('Enter').catch(() => undefined);
        }

        await navigationPromise;
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(1_000);
    }

    private async maybeTrustCurrentBrowser(page: Page) {
        const selectors = [
            'input[type="checkbox"][name*="remember"]',
            'input[type="checkbox"][id*="remember"]',
            'input[type="checkbox"][name*="browser"]',
            'input[type="checkbox"][id*="browser"]',
            'input[type="checkbox"][name*="trust"]',
            'input[type="checkbox"][id*="trust"]',
        ];
        for (const selector of selectors) {
            const locator = page.locator(selector).first();
            const count = await locator.count().catch(() => 0);
            if (!count) {
                continue;
            }
            const visible = await locator.isVisible().catch(() => false);
            if (!visible) {
                continue;
            }
            await locator.check().catch(() => undefined);
            return;
        }
    }

    private async isMfaChallengePage(page: Page, knownContent?: string): Promise<boolean> {
        const url = page.url();
        if (url.includes('verifyMFA')) {
            return true;
        }
        const content = knownContent ?? await page.content().catch(() => '');
        return content.includes('mfa-code')
            || content.includes('verifyMFA')
            || content.includes('验证码')
            || content.includes('verification');
    }

    private async extractTicketFromPage(page: Page): Promise<string | null> {
        const urlTicket = extractTicket(page.url());
        if (urlTicket) {
            return urlTicket;
        }

        const content = await page.content().catch(() => '');
        if (!content) {
            return null;
        }

        return extractTicket(content);
    }

    private async getPageSnippet(page: Page): Promise<string> {
        const text = await page.locator('body').innerText().catch(() => page.url());
        return sanitizeMessage(text || page.url()) || '页面没有返回可识别的提示信息';
    }

    private async finalizeSuccessfulLogin(ticket: string, successMessage: string): Promise<Account2ActionResponse> {
        // ticket 是一次性的，这里失败就只能重来一轮（会再收一封验证码邮件）。
        // 刻意不做「退回到库的 login()」兜底：库对 MFA 账号的处理是空实现，必然失败，
        // 而且会再触发一封验证码邮件，纯粹是骚扰 + 增加佳明侧风控计数。
        await exchangeAndSaveToken(ticket, {
            region: 'CN',
            sessionUser: this.config.cn.sessionUser,
        });
        console.log('[Account2Auth] Ticket exchange 成功');

        await getGaminCNClient({
            label: '账号2 国区',
            username: this.config.cn.username,
            password: this.config.cn.password,
            sessionUser: this.config.cn.sessionUser,
            authStateKey: this.config.accountKey,
        });
        await markAccountAuthReady(this.config.accountKey);
        await this.disposePendingPage();
        return {
            status: 'ready',
            message: successMessage,
            account: await this.getStatus(),
        };
    }
}

export const account2AuthService = new Account2AuthService();
