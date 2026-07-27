import { HTTP_TIMEOUT_MS } from '../constant';
import {
    createReauthRequiredError,
    createTransientError,
    isAuthFailure,
    refreshAndSaveToken,
    sendBarkNotification,
    verifyProfileWithRetry,
} from './garmin_common';
import { GarminClientType, GarminLoginOptions } from './type';
import { getSessionFromDB, initDB } from './sqlite';

const { GarminConnect } = require('@gooin/garmin-connect');

const REMINT_HINT = '请按 README「国际区 token 过期了怎么办」重新铸票，再跑 yarn import:global-token';

/**
 * 国际区客户端。**只消费已存的 token，绝不主动密码登录。**
 *
 * 2026-03 起 sso.garmin.com 前面挂了 Cloudflare bot 检测，库用的 axios 指纹会被直接
 * 拦（429）；社区实证限流是按「账号 + clientId」计的，换 IP 没用，反复重试会升级成
 * 账号级封锁 48-72 小时。
 *
 * 这里最容易犯的错，是把「OAuth1 过期」当成瞬时错误然后 fallback 去密码登录——那会
 * 变成每次同步都拿真实账号去撞 Cloudflare，而表面上只报「稍后重试」，几周都发现不了。
 * 所以失效时一律抛 REAUTH_REQUIRED，让人去铸票。
 */
export const getGaminGlobalClient = async (config: GarminLoginOptions): Promise<GarminClientType> => {
    await initDB();

    const currentSession = await getSessionFromDB('GLOBAL', config.sessionUser);
    if (!currentSession) {
        throw createReauthRequiredError('GLOBAL', config.label, `库里没有国际区 token，${REMINT_HINT}`);
    }

    const client: GarminClientType = new GarminConnect({
        username: config.username,
        // 库的构造函数不接受空密码；这里永远不会真的用它去登录
        password: config.password || '-',
        timeout: HTTP_TIMEOUT_MS,
    });
    client.loadToken(currentSession.oauth1, currentSession.oauth2);

    try {
        const userInfo = await verifyProfileWithRetry(client, config.label);
        console.log(`[${config.label}] 国际区登录态有效:`, { fullName: userInfo?.fullName });
        await refreshAndSaveToken(client, 'GLOBAL', config.sessionUser);
        return client;
    } catch (err: any) {
        if (!isAuthFailure(err)) {
            throw createTransientError(`${config.label} 国际区`, err?.message ?? '未知网络错误');
        }
        // 长效 OAuth1 真的死了。刻意不删这一行、更不去密码登录。
        await sendBarkNotification(
            `${config.label} 国际区 token 已失效`,
            '需要重新铸票并导入，同步已暂停',
        );
        throw createReauthRequiredError('GLOBAL', config.label, `OAuth1 已失效，${REMINT_HINT}`);
    }
};
