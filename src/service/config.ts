export const ACCOUNT2_AUTH_STATE_KEY = 'ACCOUNT2';

export interface Account2ServiceConfig {
    accountKey: string;
    port: number;
    appBaseUrl: string;
    secureCookies: boolean;
    adminSessionCookieName: string;
    adminSessionTtlMs: number;
    playwrightProfileDir: string;
    playwrightHeadless: boolean;
    cn: {
        username: string;
        password: string;
    };
    global: {
        username: string;
        password: string;
    };
    admin: {
        username: string;
        password: string;
    };
    webhookToken: string;
    /** 自动从邮箱读 MFA 验证码的配置；未配置 MAIL_IMAP_PASSWORD 时为 null（回退到管理页人工提交） */
    mail: {
        host: string;
        port: number;
        secure: boolean;
        user: string;
        password: string;
    } | null;
}

function requireEnv(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`缺少环境变量 ${name}`);
    }
    return value;
}

function buildMailConfig(): Account2ServiceConfig['mail'] {
    const password = process.env.MAIL_IMAP_PASSWORD?.trim();
    if (!password) {
        return null;
    }
    const port = Number(process.env.MAIL_IMAP_PORT || '993');
    return {
        host: process.env.MAIL_IMAP_HOST?.trim() || 'imap.163.com',
        port: Number.isFinite(port) && port > 0 ? port : 993,
        secure: process.env.MAIL_IMAP_SECURE !== 'false',
        // 默认用国区 Garmin 账号邮箱（即收验证码的邮箱）
        user: process.env.MAIL_IMAP_USER?.trim() || requireEnv('GARMIN_USERNAME_2'),
        password,
    };
}

let cachedConfig: Account2ServiceConfig | undefined;

export function getAccount2ServiceConfig(): Account2ServiceConfig {
    if (cachedConfig) {
        return cachedConfig;
    }

    const port = Number(process.env.PORT || '3000');
    if (!Number.isFinite(port) || port <= 0) {
        throw new Error('PORT 环境变量无效');
    }

    const appBaseUrl = process.env.APP_BASE_URL?.trim() || `http://localhost:${port}`;
    const ttlMinutes = Number(process.env.ADMIN_SESSION_TTL_MINUTES || '720');
    const adminSessionTtlMs = Number.isFinite(ttlMinutes) && ttlMinutes > 0
        ? ttlMinutes * 60 * 1000
        : 12 * 60 * 60 * 1000;

    cachedConfig = {
        accountKey: ACCOUNT2_AUTH_STATE_KEY,
        port,
        appBaseUrl,
        secureCookies: appBaseUrl.startsWith('https://'),
        adminSessionCookieName: process.env.ADMIN_SESSION_COOKIE_NAME?.trim() || 'dailysync_admin_session',
        adminSessionTtlMs,
        playwrightProfileDir: process.env.PLAYWRIGHT_PROFILE_DIR?.trim() || './db/playwright/account2',
        playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS !== 'false',
        cn: {
            username: requireEnv('GARMIN_USERNAME_2'),
            password: requireEnv('GARMIN_PASSWORD_2'),
        },
        global: {
            username: requireEnv('GARMIN_GLOBAL_USERNAME_2'),
            password: requireEnv('GARMIN_GLOBAL_PASSWORD_2'),
        },
        admin: {
            username: requireEnv('ADMIN_USERNAME'),
            password: requireEnv('ADMIN_PASSWORD'),
        },
        webhookToken: requireEnv('ACCOUNT2_SYNC_WEBHOOK_TOKEN'),
        mail: buildMailConfig(),
    };

    return cachedConfig;
}
