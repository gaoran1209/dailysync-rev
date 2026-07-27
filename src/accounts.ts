import { GarminSyncOptions } from './utils/type';

export const ACCOUNT2_AUTH_STATE_KEY = 'ACCOUNT2';

function env(...names: string[]): string | undefined {
    for (const name of names) {
        const value = process.env[name]?.trim();
        if (value) return value;
    }
    return undefined;
}

function requireEnv(label: string, ...names: string[]): string {
    const value = env(...names);
    if (!value) {
        throw new Error(`缺少 ${label} 的环境变量：${names.join(' 或 ')}（检查仓库根目录的 .env）`);
    }
    return value;
}

export type AccountId = '1' | '2';

export interface AccountDef {
    id: AccountId;
    label: string;
    sync: GarminSyncOptions;
}

/**
 * 两个使用者各自的国区/国际区账号。
 *
 * 用户名是必填的（它同时是 garmin_session 表的行键）；密码是可选的，只有显式的
 * relogin 命令才会用到——定时同步永远不会去密码登录，见 utils/type.ts 的说明。
 */
export function getAccount(id: AccountId): AccountDef {
    if (id === '1') {
        const cnUser = requireEnv('账号1 国区用户名', 'GARMIN_USERNAME', 'GARMIN_USERNAME_DEFAULT');
        const globalUser = requireEnv('账号1 国际区用户名', 'GARMIN_GLOBAL_USERNAME', 'GARMIN_GLOBAL_USERNAME_DEFAULT');
        return {
            id,
            label: '账号1',
            sync: {
                cn: {
                    label: '账号1 国区',
                    username: cnUser,
                    password: env('GARMIN_PASSWORD', 'GARMIN_PASSWORD_DEFAULT'),
                    sessionUser: cnUser,
                },
                global: {
                    label: '账号1 国际区',
                    username: globalUser,
                    password: env('GARMIN_GLOBAL_PASSWORD', 'GARMIN_GLOBAL_PASSWORD_DEFAULT'),
                    sessionUser: globalUser,
                },
            },
        };
    }

    const cnUser = requireEnv('账号2 国区用户名', 'GARMIN_USERNAME_2');
    const globalUser = requireEnv('账号2 国际区用户名', 'GARMIN_GLOBAL_USERNAME_2');
    return {
        id,
        label: '账号2',
        sync: {
            cn: {
                label: '账号2 国区',
                username: cnUser,
                password: env('GARMIN_PASSWORD_2'),
                sessionUser: cnUser,
                authStateKey: ACCOUNT2_AUTH_STATE_KEY,
            },
            global: {
                label: '账号2 国际区',
                username: globalUser,
                password: env('GARMIN_GLOBAL_PASSWORD_2'),
                sessionUser: globalUser,
            },
        },
    };
}

/** relogin 类命令用：密码这时是硬需求，缺了要立刻报错而不是拿占位串去撞登录 */
export function requirePassword(options: { label: string; password?: string }): string {
    if (!options.password) {
        throw new Error(`${options.label} 缺少密码，请先在 .env 里补上再重试`);
    }
    return options.password;
}
