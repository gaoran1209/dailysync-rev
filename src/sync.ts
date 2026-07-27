/**
 * 定时同步入口：把国区的新活动同步到国际区。
 *
 *   yarn sync           两个账号都同步
 *   yarn sync 1         只同步账号1
 *   yarn sync 2         只同步账号2
 *
 * 正常路径只消费已存的 OAuth token，不会触发任何登录、也不会触发邮箱验证码。
 * token 失效时抛 REAUTH_REQUIRED 并发 Bark，需要人工在本机跑对应的重新登录命令。
 */

import { loadDotEnv } from './utils/dotenv';

loadDotEnv();

// 下面这些模块在 import 期就会读环境变量，必须放在 loadDotEnv() 之后延迟加载
const { getAccount } = require('./accounts') as typeof import('./accounts');
const { syncGarminCN2GarminGlobal } = require('./utils/garmin_cn') as typeof import('./utils/garmin_cn');
const { sendBarkNotification } = require('./utils/garmin_common') as typeof import('./utils/garmin_common');
const { closeDB } = require('./utils/sqlite') as typeof import('./utils/sqlite');

type AccountId = '1' | '2';

interface RunOutcome {
    account: AccountId;
    status: 'ok' | 'no_new_data' | 'partial' | 'skipped' | 'reauth_required' | 'failed';
    uploadedCount: number;
    message: string;
    /** 带上时间戳，scripts/sync-report.js 靠它做「过去 24 小时」的时间窗过滤 */
    at?: string;
}

async function runOne(id: AccountId): Promise<RunOutcome> {
    // getAccount 也要放进 try：它在缺环境变量时会抛，放外面的话账号1 配错会直接
    // 掀掉整个进程，账号2 连跑都不跑
    let label = `账号${id}`;
    try {
        const account = getAccount(id);
        label = account.label;
        console.log(`\n===== ${label} 开始同步 =====`);
        const result = await syncGarminCN2GarminGlobal(account.sync);
        console.log(`[${label}] ${result.message}`);
        return {
            account: id,
            status: result.status,
            uploadedCount: result.uploadedCount,
            message: result.message,
        };
    } catch (err: any) {
        const message = String(err?.message ?? err);

        // 网络抖动/佳明 5xx：登录态仍然有效，本次跳过即可，不告警
        if (message.includes('TRANSIENT_ERROR')) {
            console.log(`[${label}] 瞬时错误，本次跳过: ${message}`);
            return { account: id, status: 'skipped', uploadedCount: 0, message };
        }

        // 登录态真失效：必须人工介入，这条一定要推送出去
        if (message.includes('REAUTH_REQUIRED')) {
            console.error(`[${label}] 需要重新登录: ${message}`);
            await sendBarkNotification(`${label} 需要重新登录`, message);
            return { account: id, status: 'reauth_required', uploadedCount: 0, message };
        }

        console.error(`[${label}] 同步失败: ${message}`);
        await sendBarkNotification(`${label} 同步失败`, message);
        return { account: id, status: 'failed', uploadedCount: 0, message };
    }
}

async function main() {
    const arg = process.argv[2]?.trim();
    const targets: AccountId[] = arg === '1' || arg === '2' ? [arg] : ['1', '2'];

    const outcomes: RunOutcome[] = [];
    for (const id of targets) {
        // 一个账号失败不影响另一个账号——runOne 内部已经把异常都收敛成结果了
        outcomes.push(await runOne(id));
    }

    // 供 scripts/sync-report.js 解析的机器可读结果行
    for (const outcome of outcomes) {
        console.log(`[SYNC-RESULT] ${JSON.stringify({ ...outcome, at: new Date().toISOString() })}`);
    }

    const hasFailure = outcomes.some(o => o.status === 'failed' || o.status === 'reauth_required');
    return hasFailure ? 1 : 0;
}

main()
    .then(async (code) => {
        await closeDB();
        process.exit(code);
    })
    .catch(async (err) => {
        console.error('同步进程异常退出:', err?.message ?? err);
        await sendBarkNotification('佳明同步进程异常退出', String(err?.message ?? err)).catch(() => undefined);
        await closeDB().catch(() => undefined);
        process.exit(1);
    });
