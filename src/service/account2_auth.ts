import { chromium, type BrowserContext, type Page } from 'playwright';
import { exchangeAndSaveToken, extractTicket } from '../mfa/garmin_sso_mfa';
import { getGaminCNClient } from '../utils/garmin_cn';
import { refreshAndSaveToken } from '../utils/garmin_common';
import {
    getAccountAuthState,
    getSessionFromDB,
    initDB,
    markAccountAuthAwaitingCode,
    markAccountAuthError,
    markAccountAuthReady,
    markAccountAuthReauthRequired,
} from '../utils/sqlite';
import { getAccount2ServiceConfig } from './config';

const { GarminConnect } = require('@gooin/garmin-connect');

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
    private readonly config = getAccount2ServiceConfig();
    private contextPromise: Promise<BrowserContext> | null = null;
    private pendingLogin: PendingLoginState | null = null;

    async getStatus(): Promise<Account2StatusSnapshot> {
        await initDB();
        const state = await getAccountAuthState(this.config.accountKey);
        const hasStoredCnSession = Boolean(await getSessionFromDB('CN', this.config.cn.username).catch(() => undefined));
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

    async startLogin(): Promise<Account2ActionResponse> {
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
                    message: '验证码邮件已发送，请在管理页提交邮箱验证码完成登录',
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

    async verifyCode(rawCode: string): Promise<Account2ActionResponse> {
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
            await this.submitForm(page);

            const ticket = await this.extractTicketFromPage(page);
            if (ticket) {
                return await this.finalizeSuccessfulLogin(ticket, 'Garmin CN 登录成功，Token 已保存到数据库');
            }

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
        // 策略 1: 用 ticket 直接交换 OAuth token
        try {
            await exchangeAndSaveToken(ticket, {
                region: 'CN',
                sessionUser: this.config.cn.username,
            });
            console.log('[Account2Auth] Ticket exchange 成功');
        } catch (exchangeErr) {
            console.log('[Account2Auth] Ticket exchange 失败，尝试直接 login:', exchangeErr.message);
            // 策略 2: MFA 刚完成，同一 IP 短期内不需要再次验证，直接用库的 login
            await this.loginViaLibraryFallback();
        }

        await getGaminCNClient({
            username: this.config.cn.username,
            password: this.config.cn.password,
            sessionUser: this.config.cn.username,
            loginMode: 'token_only',
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

    private async loginViaLibraryFallback(): Promise<void> {
        const GCClient = new GarminConnect({
            username: this.config.cn.username,
            password: this.config.cn.password,
        }, 'garmin.cn');
        await GCClient.login(this.config.cn.username, this.config.cn.password);
        await refreshAndSaveToken(GCClient, 'CN', this.config.cn.username);
        console.log('[Account2Auth] Library login fallback 成功');
    }
}

export const account2AuthService = new Account2AuthService();
