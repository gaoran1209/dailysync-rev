import * as os from 'os';
import * as path from 'path';

/**
 * 运行时数据目录。
 *
 * 所有会变化、且包含凭据的东西都放在这里，**刻意放在仓库之外**：
 *   - garmin.db          加密的 OAuth session
 *   - playwright/        账号2 登录用的 Chromium 持久化 profile（含站点 cookie）
 *   - fit/               同步过程中下载的原始活动文件
 *   - logs/              launchd 定时任务的日志
 *   - global_token.json  国际区铸票的中间产物
 *
 * 这样 token 在物理上就不可能被 git 提交，也避开了仓库所在的 iCloud 同步目录
 * （iCloud 会对 sqlite WAL 和 Chromium profile 做逐字节同步与逐出）。
 */
export const DATA_DIR = process.env.DAILYSYNC_DATA_DIR?.trim() || path.join(os.homedir(), '.dailysync');

export const DB_FILE_PATH = process.env.DB_FILE_PATH?.trim() || path.join(DATA_DIR, 'garmin.db');
export const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR?.trim() || path.join(DATA_DIR, 'fit');
export const PLAYWRIGHT_PROFILE_DIR = process.env.PLAYWRIGHT_PROFILE_DIR?.trim()
    || path.join(DATA_DIR, 'playwright', 'account2');
export const GLOBAL_TOKEN_PATH = process.env.GLOBAL_TOKEN_PATH?.trim()
    || path.join(DATA_DIR, 'global_token.json');

export const FILE_SUFFIX = {
    FIT: 'fit',
    GPX: 'gpx',
    TCX: 'tcx',
};

/**
 * session 加密密钥。保留兜底值是为了兼容已有的 garmin.db —— 换掉它会让所有已存的
 * session 解密失败并触发重新登录（账号2 意味着一次邮箱验证码流程）。想轮换的话：
 * 先在本机用旧 key 解出、用新 key 重新加密全部行，再改 .env。
 */
export const AESKEY_DEFAULT = process.env.AESKEY || 'LSKDAJALSD';

/** 每次同步检查最近多少条活动（两侧各取这么多做指纹差集） */
export const GARMIN_SYNC_NUM_DEFAULT = 10;

export const GARMIN_URL_DEFAULT = {
    BASE_URL: 'https://connect.garmin.cn',
    ACTIVITY_URL: 'https://connect.garmin.cn/modern/activity/',
    SSO_URL_ORIGIN: 'https://sso.garmin.com',
    SSO_URL: 'https://sso.garmin.cn/sso',
    MODERN_URL: 'https://connect.garmin.cn/modern',
    SIGNIN_URL: 'https://sso.garmin.cn/sso/signin',
};

export const UA_DEFAULT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const BARK_KEY_DEFAULT = process.env.BARK_KEY || '';

/** 请求超时。库的默认值是 5 秒，对跨境访问佳明来说太短，超时会被误判成登录失效。 */
export const HTTP_TIMEOUT_MS = Number(process.env.GARMIN_HTTP_TIMEOUT_MS || 30_000);
