/**
 * 从邮箱 IMAP 自动读取 Garmin MFA 验证码
 *
 * 用于 163 邮箱（imap.163.com）等支持 IMAP 的邮箱。
 * 163 需要在邮箱设置中开启 IMAP 并生成「授权码」，用授权码而非登录密码认证。
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

export interface MailFetcherConfig {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
}

export interface FetchCodeOptions {
    /** 只接受该时间点之后收到的邮件（毫秒时间戳） */
    sinceMs: number;
    /** 轮询总超时（毫秒），默认 4 分钟 */
    timeoutMs?: number;
    /** 轮询间隔（毫秒），默认 15 秒 */
    pollIntervalMs?: number;
}

const GARMIN_SENDER_PATTERN = /garmin/i;
// 关键词附近的 6 位码（“验证码/安全密码/code/verification …… 123456”），优先级最高
const KEYWORD_CODE_PATTERN = /(?:验证码|安全密码|verification code|security code|passcode|one[- ]?time)[^\d]{0,40}(\d{6})/i;
const CODE_PATTERN = /\b(\d{6})\b/g;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 判断一个 6 位串是否明显不是验证码（颜色值/年份/占位等）
 * 例如 000000（黑色 #000000）、111111、202601 等。
 */
function isImplausibleCode(code: string): boolean {
    if (/^(\d)\1{5}$/.test(code)) return true;           // 全相同数字：000000 / 111111
    if (/^20\d{4}$/.test(code) && Number(code.slice(2, 4)) <= 12) {
        // 形如 2026xx 的日期/年份前缀，且第 3-4 位是合法月份，较可能是日期戳
        return true;
    }
    return false;
}

function extractCodeFromText(text: string | undefined | null): string | null {
    if (!text) return null;

    // 1) 优先：验证码/安全密码等关键词后面紧跟的 6 位数字（Garmin 邮件正文格式）
    const kw = text.match(KEYWORD_CODE_PATTERN);
    if (kw?.[1] && !isImplausibleCode(kw[1])) {
        return kw[1];
    }

    // 2) 兜底：全文所有 6 位数字候选，去掉颜色值/重复数字等明显噪声
    const candidates = Array.from(text.matchAll(CODE_PATTERN)).map(m => m[1]);
    for (const c of candidates) {
        if (!isImplausibleCode(c)) {
            return c;
        }
    }
    return null;
}

/**
 * 单次连接邮箱，查找 sinceMs 之后 Garmin 发来的验证码邮件
 */
async function fetchCodeOnce(config: MailFetcherConfig, sinceMs: number): Promise<string | null> {
    const client = new ImapFlow({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
            user: config.user,
            pass: config.password,
        },
        logger: false,
        // 163 要求客户端发送 IMAP ID 信息，否则报 Unsafe Login
        clientInfo: {
            name: 'DailySyncMailFetcher',
            version: '1.0.0',
            vendor: 'dailysync',
        },
    });

    await client.connect();
    try {
        const lock = await client.getMailboxLock('INBOX');
        try {
            // SINCE 只精确到天，先按天过滤再按 internalDate 精确过滤
            const sinceDate = new Date(sinceMs - 24 * 60 * 60 * 1000);
            const uids: number[] = await client.search({ since: sinceDate }, { uid: true });
            if (!uids || uids.length === 0) {
                return null;
            }

            // 只看最近的 20 封，从最新往回找
            const candidates = uids.slice(-20).reverse();
            for (const uid of candidates) {
                const message = await client.fetchOne(
                    uid,
                    { envelope: true, internalDate: true, source: true },
                    { uid: true },
                );
                if (!message) continue;

                const internalDate = message.internalDate ? new Date(message.internalDate).getTime() : 0;
                // 允许 60 秒时钟偏差
                if (internalDate < sinceMs - 60 * 1000) {
                    continue;
                }

                const fromText = (message.envelope?.from ?? [])
                    .map((f: any) => `${f.name ?? ''} ${f.address ?? ''}`)
                    .join(' ');
                const subject = message.envelope?.subject ?? '';
                if (!GARMIN_SENDER_PATTERN.test(fromText) && !GARMIN_SENDER_PATTERN.test(subject)) {
                    continue;
                }

                let code = extractCodeFromText(subject);
                if (!code && message.source) {
                    try {
                        const parsed = await simpleParser(message.source);
                        code = extractCodeFromText(parsed.text)
                            ?? extractCodeFromText(parsed.html ? String(parsed.html) : null)
                            ?? extractCodeFromText(parsed.subject);
                    } catch (parseErr) {
                        console.log('[MailFetcher] 邮件解析失败，跳过:', parseErr.message);
                    }
                }

                if (code) {
                    console.log(`[MailFetcher] 找到 Garmin 验证码邮件（${new Date(internalDate).toISOString()}）`);
                    return code;
                }
            }
            return null;
        } finally {
            lock.release();
        }
    } finally {
        await client.logout().catch(() => undefined);
    }
}

/**
 * 轮询邮箱直到拿到 Garmin MFA 验证码或超时
 */
export async function fetchGarminMfaCode(
    config: MailFetcherConfig,
    options: FetchCodeOptions,
): Promise<string> {
    const timeoutMs = options.timeoutMs ?? 4 * 60 * 1000;
    const pollIntervalMs = options.pollIntervalMs ?? 15 * 1000;
    const deadline = Date.now() + timeoutMs;

    console.log(`[MailFetcher] 开始轮询 ${config.user} 的邮箱等待 Garmin 验证码（最长 ${Math.round(timeoutMs / 1000)} 秒）...`);

    let lastError: Error | null = null;
    while (Date.now() < deadline) {
        try {
            const code = await fetchCodeOnce(config, options.sinceMs);
            if (code) {
                return code;
            }
            lastError = null;
        } catch (err) {
            lastError = err;
            console.log('[MailFetcher] 本轮读取邮箱失败:', err.message);
        }
        await sleep(pollIntervalMs);
    }

    throw new Error(
        `MAIL_CODE_TIMEOUT: 在 ${Math.round(timeoutMs / 1000)} 秒内未从邮箱读到 Garmin 验证码` +
        (lastError ? `（最后错误: ${lastError.message}）` : ''),
    );
}
