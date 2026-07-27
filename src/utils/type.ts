export interface GarminExportedToken {
    oauth1: Record<string, any>;
    oauth2: Record<string, any>;
}

export interface GarminClientType {
    client: {
        oauth1Token?: Record<string, any>;
        oauth2Token?: Record<string, any>;
        fetchOauthConsumer?: () => Promise<void>;
        getOauth1Token?: (ticket: string) => Promise<Record<string, any>>;
        exchange?: (oauth1: Record<string, any>) => Promise<void>;
    };
    exportToken: () => GarminExportedToken;
    loadToken: (oauth1: Record<string, any>, oauth2: Record<string, any>) => void;
    login: (username?: string, password?: string) => Promise<GarminClientType>;
    getUserProfile: () => Promise<Record<string, any>>;
    getActivities: (start?: number, limit?: number) => Promise<Record<string, any>[]>;
    getActivity: (activity: Record<string, any>) => Promise<Record<string, any>>;
    downloadOriginalActivityData: (activity: Record<string, any>, dir: string, type?: string) => Promise<void>;
    uploadActivity: (path: string, format?: string) => Promise<Record<string, any>>;
}

/**
 * 定时同步用的账号信息。
 *
 * 这里刻意**没有**「登录模式」这个开关：同步过程永远只消费已存的 OAuth token，
 * 任何情况下都不会自己去做账号密码登录。原因是两条都不能碰——
 *   - 国际区 sso.garmin.com 有 Cloudflare bot 检测，脚本登录必被 429，且限流按
 *     「账号 + clientId」计，反复重试会升级成账号级封锁 48-72 小时；
 *   - 账号2 国区开了 ECG，密码登录必然触发验证码邮件，无人值守时只会白发邮件。
 * token 失效时一律抛 REAUTH_REQUIRED + 推送，由人跑对应的 relogin 命令。
 *
 * label / sessionUser 都是必填：漏传会让 session 写错行或用错身份，而 sqlite 是
 * 二进制文件，覆盖了只能翻备份。
 */
export interface GarminLoginOptions {
    /** 人类可读标签，用于日志和通知，例如「账号1 国区」 */
    label: string;
    username: string;
    /** 只有显式的 relogin 命令会用到；同步路径用不上，可以留空 */
    password?: string;
    /** garmin_session 表里的行键，通常等于 username */
    sessionUser: string;
    /** 需要记录登录态状态时传，例如 'ACCOUNT2' */
    authStateKey?: string;
}

export interface GarminSyncOptions {
    cn: GarminLoginOptions;
    global: GarminLoginOptions;
}

export interface GarminSyncResult {
    status: 'ok' | 'no_new_data' | 'partial';
    uploadedCount: number;
    failedCount?: number;
    skippedCount?: number;
    message: string;
    latestSourceStartTime?: string;
    latestTargetStartTime?: string;
}
