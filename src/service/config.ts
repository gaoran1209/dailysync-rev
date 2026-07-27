import { PLAYWRIGHT_PROFILE_DIR } from '../constant';
import { ACCOUNT2_AUTH_STATE_KEY, getAccount, requirePassword } from '../accounts';

export interface Account2AuthConfig {
    accountKey: string;
    playwrightProfileDir: string;
    playwrightHeadless: boolean;
    cn: { username: string; password: string; sessionUser: string };
    global: { username: string; password: string; sessionUser: string };
    /** 自动从邮箱读验证码的配置；没配 MAIL_IMAP_PASSWORD 时为 null，此时只能人工输码 */
    mail: {
        host: string;
        port: number;
        secure: boolean;
        user: string;
        password: string;
    } | null;
}

function buildMailConfig(cnUsername: string): Account2AuthConfig['mail'] {
    const password = process.env.MAIL_IMAP_PASSWORD?.trim();
    if (!password) {
        return null;
    }
    const port = Number(process.env.MAIL_IMAP_PORT || '993');
    return {
        host: process.env.MAIL_IMAP_HOST?.trim() || 'imap.163.com',
        port: Number.isFinite(port) && port > 0 ? port : 993,
        secure: process.env.MAIL_IMAP_SECURE !== 'false',
        // 默认用账号2 的国区用户名（它本身就是收验证码的那个 163 邮箱）
        user: process.env.MAIL_IMAP_USER?.trim() || cnUsername,
        password,
    };
}

let cachedConfig: Account2AuthConfig | undefined;

/** 这份配置是给「重新登录」用的，所以密码在这里是硬需求，缺了必须当场报错。 */
export function getAccount2AuthConfig(): Account2AuthConfig {
    if (cachedConfig) {
        return cachedConfig;
    }
    const account = getAccount('2');
    const config: Account2AuthConfig = {
        accountKey: ACCOUNT2_AUTH_STATE_KEY,
        playwrightProfileDir: PLAYWRIGHT_PROFILE_DIR,
        // 默认开着浏览器窗口跑：本机重新登录是人工触发的低频操作，看得见更好排查
        playwrightHeadless: process.env.PLAYWRIGHT_HEADLESS === 'true',
        cn: {
            username: account.sync.cn.username,
            password: requirePassword(account.sync.cn),
            sessionUser: account.sync.cn.sessionUser,
        },
        global: {
            username: account.sync.global.username,
            password: account.sync.global.password ?? '-',
            sessionUser: account.sync.global.sessionUser,
        },
        mail: buildMailConfig(account.sync.cn.username),
    };
    cachedConfig = config;
    return config;
}
