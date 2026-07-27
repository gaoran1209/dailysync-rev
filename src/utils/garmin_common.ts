import * as fs from 'fs';
import { BARK_KEY_DEFAULT, DOWNLOAD_DIR } from '../constant';
import { GarminClientType } from './type';
import { getSessionFromDB, saveSessionToDB, updateSessionToDB } from './sqlite';

const axios = require('axios');
const decompress = require('decompress');

const BARK_KEY = BARK_KEY_DEFAULT;

/** 发 Bark 推送。发送失败只打日志，绝不往上抛——通知失败不该把同步搞挂。 */
export const sendBarkNotification = async (title: string, message: string): Promise<void> => {
    if (!BARK_KEY) {
        console.log(`[Bark] 未配置 BARK_KEY，跳过通知: ${title} - ${message}`);
        return;
    }
    try {
        await axios.get(
            `https://api.day.app/${BARK_KEY}/${encodeURIComponent(title)}/${encodeURIComponent(message)}`,
            { timeout: 10_000 },
        );
        console.log(`[Bark] 通知已发送: ${title}`);
    } catch (e: any) {
        console.log(`[Bark] 通知发送失败: ${e.message}`);
    }
};

/**
 * 判断错误是否为「认证真的失效」——即长效 OAuth1 已经不能用了，必须重新登录。
 *
 * 分类错了代价很不对称：
 *  - 把网络抖动误判成失效 → 删掉需要邮箱验证码才能重造的 OAuth1；
 *  - 把失效误判成抖动     → 永远静默重试，不提示需要人工介入。
 *
 * 所以这里只认死证据：401、明确的 token 失效文案、以及库在 OAuth1 失效时
 * 抛的 'No OAuth2 token available'。403 刻意排除——佳明的 403 绝大多数来自
 * WAF/风控，不是 token 失效。
 */
export function isAuthFailure(err: any): boolean {
    const status = err?.response?.status ?? err?.status;
    if (status === 401) return true;

    const code = err?.code;
    if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED'].includes(code)) {
        return false;
    }

    const msg = String(err?.message ?? '');
    // 库在 OAuth1 失效、无法换出新 OAuth2 时抛的字面量
    if (msg.includes('No OAuth2 token available')) return true;
    if (msg.includes('缺少刷新令牌')) return true;
    if (/账户已锁定|account.*lock/i.test(msg)) return true;
    if (/\b401\b|unauthor|invalid[_\s-]?token|token.*(expired|invalid)/i.test(msg)) return true;
    // 库在 token 失效时抛的「佳明中国区登录失败」（getUserProfile 拿不到 fullName）
    if (msg.includes('佳明中国区登录失败')) return true;
    return false;
}

/**
 * 校验当前 token 是否可用，对瞬时错误做有限重试。
 * @throws isAuthFailure=true 的错误（认证失效，不重试），或最后一次瞬时错误
 */
export async function verifyProfileWithRetry(
    client: GarminClientType,
    label: string,
    attempts = 3,
): Promise<Record<string, any>> {
    let lastErr: any;
    for (let i = 0; i < attempts; i++) {
        try {
            const userInfo = await client.getUserProfile();
            // token 失效时佳明有时不是回 401，而是回一个没有身份字段的壳。
            // 上游就是靠这个判断的，别把它简化掉。
            if (!userInfo || (!userInfo.fullName && !userInfo.userName && !userInfo.displayName)) {
                throw new Error(`${label} 登录校验失败：getUserProfile 没有返回身份信息（invalid_token）`);
            }
            return userInfo;
        } catch (err) {
            lastErr = err;
            if (isAuthFailure(err)) {
                throw err;
            }
            if (i < attempts - 1) {
                const backoffMs = 2000 * (i + 1);
                console.log(`[${label}] getUserProfile 第 ${i + 1} 次失败（${(err as Error).message}），${backoffMs}ms 后重试...`);
                await new Promise(r => setTimeout(r, backoffMs));
            }
        }
    }
    throw lastErr;
}

export function createReauthRequiredError(region: 'CN' | 'GLOBAL', account: string, hint: string): Error {
    return new Error(`REAUTH_REQUIRED: ${account} 的佳明${region === 'CN' ? '国区' : '国际区'}登录态已失效，${hint}`);
}

export function createTransientError(label: string, cause: string): Error {
    return new Error(`TRANSIENT_ERROR: ${label} 暂时不可用（${cause}），本次跳过，保留登录态`);
}

/** 刷新并保存 Token 到数据库。每次成功调用 API 后都调一次，让滚动刷新的 OAuth2 落库。 */
export const refreshAndSaveToken = async (
    client: GarminClientType,
    region: 'CN' | 'GLOBAL',
    sessionUser: string,
): Promise<void> => {
    try {
        const token = client.exportToken();
        const existingSession = await getSessionFromDB(region, sessionUser);
        if (existingSession) {
            await updateSessionToDB(region, token, sessionUser);
        } else {
            await saveSessionToDB(region, token, sessionUser);
        }
        console.log(`[Token] ${region} token 已更新到数据库`);
    } catch (e: any) {
        console.log(`[Token] ${region} token 更新失败: ${e.message}`);
    }
};

/** 上传 .fit 文件。上传失败必须抛出，否则同步会虚报成功、活动被永久跳过。 */
export const uploadGarminActivity = async (fitFilePath: string, client: GarminClientType): Promise<void> => {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const upload = await client.uploadActivity(fitFilePath);
    console.log('upload to garmin activity', upload);
};

/** 下载佳明活动原始数据并解压，返回解压后的文件路径 */
export const downloadGarminActivity = async (activityId: any, client: GarminClientType): Promise<string> => {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    const activity = await client.getActivity({ activityId });
    await client.downloadOriginalActivityData(activity, DOWNLOAD_DIR);
    const originZipFile = `${DOWNLOAD_DIR}/${activityId}.zip`;
    const unzipped = await decompress(originZipFile, DOWNLOAD_DIR);
    const unzippedFileName = unzipped?.[0]?.path;
    if (!unzippedFileName) {
        throw new Error(`活动 ${activityId} 的原始文件解压后为空`);
    }
    const filePath = `${DOWNLOAD_DIR}/${unzippedFileName}`;
    console.log('downloadGarminActivity - path:', filePath);
    return filePath;
};
