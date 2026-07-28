#!/usr/bin/env node
/**
 * 同步服务健康检查 + 飞书告警
 *
 *   node scripts/health-check.js            # 只打印状态，退出码 0=健康 1=有问题
 *   node scripts/health-check.js --json     # 输出 JSON
 *   node scripts/health-check.js --notify   # 有问题时推飞书；恢复时也推一条
 *
 * 设计原则：监控本身必须是确定性的，不依赖 LLM，也不依赖网络（除了推送那一步）。
 * 判断依据全部来自 launchd 状态和本地日志，跑得飞快。
 *
 * 去重：同一个问题不会每 30 分钟轰炸一次。只有「问题指纹变化」或「同一问题持续
 * 满 6 小时」才会再推一次；问题消失时推一条恢复通知。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.DAILYSYNC_DATA_DIR || path.join(os.homedir(), '.dailysync');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const STATE_FILE = path.join(DATA_DIR, 'health-state.json');
const LABEL = 'xyz.gaoran.dailysync';
const LARK_CLI = process.env.LARK_CLI || '/opt/homebrew/bin/lark-cli';
const FEISHU_USER_ID = process.env.DAILYSYNC_FEISHU_USER_ID || 'ou_cd7b184679d89c65938191f7c824277d';

/** 同步每 6 小时一次；超过这个时长没有成功运行就算「停摆」 */
const STALE_HOURS = Number(process.env.DAILYSYNC_STALE_HOURS || 7);
/** 同一个问题持续多久后再提醒一次 */
const RENOTIFY_HOURS = Number(process.env.DAILYSYNC_RENOTIFY_HOURS || 6);

const NOTIFY = process.argv.includes('--notify');
const AS_JSON = process.argv.includes('--json');

function sh(cmd, args) {
    try {
        return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        return null;
    }
}

/** 读最近两天日志里的 [SYNC-RESULT] 行 */
function readResults() {
    if (!fs.existsSync(LOG_DIR)) return [];
    const files = fs.readdirSync(LOG_DIR)
        .filter(f => /^sync-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort()
        .slice(-3);
    const out = [];
    for (const f of files) {
        let content;
        try { content = fs.readFileSync(path.join(LOG_DIR, f), 'utf8'); } catch { continue; }
        for (const line of content.split('\n')) {
            const i = line.indexOf('[SYNC-RESULT]');
            if (i === -1) continue;
            try {
                const j = JSON.parse(line.slice(i + '[SYNC-RESULT]'.length).trim());
                if (j.at) out.push(j);
            } catch { /* 半行日志 */ }
        }
    }
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function check() {
    const problems = [];
    const now = Date.now();

    // 1) launchd 定时任务是否还在
    const printed = sh('/bin/launchctl', ['print', `gui/${process.getuid()}/${LABEL}`]);
    if (!printed) {
        problems.push({
            level: 'critical',
            key: 'launchd-missing',
            title: '定时任务不见了',
            detail: `launchd 里找不到 ${LABEL}，同步已经完全停了。重装：bash scripts/install-launchd.sh`,
        });
    } else {
        const exitMatch = printed.match(/last exit code\s*=\s*(\d+)/);
        if (exitMatch && exitMatch[1] !== '0') {
            problems.push({
                level: 'critical',
                key: `launchd-exit-${exitMatch[1]}`,
                title: `定时任务退出码 ${exitMatch[1]}`,
                detail: exitMatch[1] === '124'
                    ? '同步超时被强制终止，可能是网络卡住或佳明无响应。'
                    : '看 ~/.dailysync/logs/ 里最近的日志。',
            });
        }
    }

    // 2) 有没有按时在跑
    const results = readResults();
    const last = results.length ? results[results.length - 1] : null;
    const lastAt = last ? Date.parse(last.at) : null;
    const hoursSince = lastAt ? (now - lastAt) / 3600000 : null;

    if (!last) {
        problems.push({
            level: 'critical',
            key: 'no-runs',
            title: '没有任何同步记录',
            detail: `${LOG_DIR} 里找不到运行结果，服务可能从没跑起来过。`,
        });
    } else if (hoursSince > STALE_HOURS) {
        problems.push({
            level: 'critical',
            key: 'stale',
            title: `已经 ${hoursSince.toFixed(1)} 小时没同步`,
            detail: `正常每 6 小时一次。最后一次是 ${new Date(lastAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}。Mac 可能睡了、关机了，或定时任务被卸载。`,
        });
    }

    // 3) 最近一轮里各账号的状态
    if (lastAt) {
        const lastRound = results.filter(r => Math.abs(Date.parse(r.at) - lastAt) < 120000);
        for (const r of lastRound) {
            if (r.status === 'reauth_required') {
                problems.push({
                    level: 'critical',
                    key: `reauth-${r.account}`,
                    title: `账号${r.account} 需要重新登录`,
                    detail: `${r.message}\n\n同步已经停在这个账号上，必须人工处理。`,
                });
            } else if (r.status === 'failed') {
                problems.push({
                    level: 'critical',
                    key: `failed-${r.account}`,
                    title: `账号${r.account} 同步失败`,
                    detail: r.message,
                });
            } else if (r.status === 'partial') {
                problems.push({
                    level: 'warn',
                    key: `partial-${r.account}`,
                    title: `账号${r.account} 部分活动上传失败`,
                    detail: `${r.message}\n\n下次同步会自动重试，连续出现才需要处理。`,
                });
            }
        }

        // 4) 连续瞬时错误 = 其实已经不是「瞬时」了
        for (const acct of ['1', '2']) {
            const mine = results.filter(r => String(r.account) === acct).slice(-3);
            if (mine.length === 3 && mine.every(r => r.status === 'skipped')) {
                problems.push({
                    level: 'warn',
                    key: `skipped-streak-${acct}`,
                    title: `账号${acct} 连续 3 次跳过`,
                    detail: `连续遇到瞬时错误，可能是网络或佳明侧持续异常：${mine[mine.length - 1].message}`,
                });
            }
        }
    }

    return {
        healthy: problems.length === 0,
        checkedAt: new Date().toISOString(),
        lastRunAt: lastAt ? new Date(lastAt).toISOString() : null,
        hoursSinceLastRun: hoursSince === null ? null : Number(hoursSince.toFixed(2)),
        problems,
    };
}

// ---------- 飞书推送 ----------

function buildCard(status) {
    const now = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
    if (status.healthy) {
        return {
            config: { wide_screen_mode: true },
            header: { template: 'green', title: { tag: 'plain_text', content: '✅ 佳明同步已恢复' } },
            elements: [
                { tag: 'markdown', content: `之前的问题已经消失，同步恢复正常。\n\n最后一次同步：${status.lastRunAt ? new Date(status.lastRunAt).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—'}` },
                { tag: 'markdown', content: `<font color='grey'>🍮 Mini 酱 · 佳明同步监控 · ${now}</font>` },
            ],
        };
    }

    const critical = status.problems.filter(p => p.level === 'critical');
    const body = status.problems
        .map(p => `**${p.level === 'critical' ? '🔴' : '🟡'} ${p.title}**\n${p.detail.replace(/\n/g, '\n')}`)
        .join('\n\n');

    return {
        config: { wide_screen_mode: true },
        header: {
            template: critical.length ? 'red' : 'orange',
            title: { tag: 'plain_text', content: critical.length ? '🔴 佳明同步异常' : '🟡 佳明同步告警' },
        },
        elements: [
            { tag: 'markdown', content: body },
            { tag: 'hr' },
            {
                tag: 'markdown',
                content: '**怎么处理**\n'
                    + '```\ncd ~/Developer/dailysync-rev\n'
                    + 'tail -50 ~/.dailysync/logs/sync-$(date +%F).log   # 看日志\n'
                    + 'corepack yarn sync                                # 手动跑一次\n'
                    + 'corepack yarn relogin:cn 1                        # 账号1 重新登录\n'
                    + 'corepack yarn relogin:account2                    # 账号2 重新登录\n```',
            },
            { tag: 'markdown', content: `<font color='grey'>🍮 Mini 酱 · 佳明同步监控 · ${now}</font>` },
        ],
    };
}

function pushFeishu(card) {
    const content = JSON.stringify(card);
    try {
        // OPENCLAW_HOME 决定 lark-cli 用哪套凭据。不设的话它会退回到 ~/.lark-cli 里
        // 那个没登录的 app，报「set valid app_id and app_secret」——从 openclaw 的
        // agent 里跑不会踩到，因为 gateway 会注入这个变量；但 cron/命令行必须自己带上。
        const out = execFileSync(LARK_CLI, [
            'im', '+messages-send',
            '--as', 'bot',
            '--user-id', FEISHU_USER_ID,
            '--msg-type', 'interactive',
            '--content', content,
        ], {
            encoding: 'utf8',
            timeout: 60000,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, OPENCLAW_HOME: process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw') },
        });
        // lark-cli 失败时也可能返回 0，得看输出里的 code
        try {
            const j = JSON.parse(out);
            if (j && j.code !== undefined && j.code !== 0) {
                return { ok: false, error: `lark-cli code=${j.code} ${j.msg || j.error?.hint || ''}`.slice(0, 400) };
            }
        } catch { /* 非 JSON 输出视为成功 */ }
        return { ok: true };
    } catch (e) {
        const detail = ((e.stdout || '') + (e.stderr || '') || e.message || '').toString();
        return { ok: false, error: detail.replace(/\s+/g, ' ').trim().slice(0, 400) };
    }
}

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(s) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** 决定这次要不要推：状态变了推，问题持续满 RENOTIFY_HOURS 再推一次，否则闭嘴 */
function decideNotify(status, state) {
    const signature = status.healthy ? 'healthy' : status.problems.map(p => p.key).sort().join('|');
    const now = Date.now();
    const lastSig = state.signature;
    const lastNotifiedAt = state.notifiedAt ? Date.parse(state.notifiedAt) : 0;

    if (signature === lastSig) {
        if (status.healthy) return { send: false, signature, reason: '一直健康，不打扰' };
        const hours = (now - lastNotifiedAt) / 3600000;
        if (hours >= RENOTIFY_HOURS) return { send: true, signature, reason: `同一问题已持续 ${hours.toFixed(1)}h，再提醒一次` };
        return { send: false, signature, reason: `同一问题 ${hours.toFixed(1)}h 内已推过，静默` };
    }
    // 状态变了
    if (status.healthy && lastSig === undefined) return { send: false, signature, reason: '首次运行且健康，不推' };
    return { send: true, signature, reason: status.healthy ? '问题已恢复' : '出现新问题' };
}

// ---------- main ----------

const status = check();
const state = loadState();
const decision = decideNotify(status, state);

let pushResult = null;
if (NOTIFY && decision.send) {
    pushResult = pushFeishu(buildCard(status));
    if (pushResult.ok) {
        saveState({ signature: decision.signature, notifiedAt: new Date().toISOString(), healthy: status.healthy });
    }
} else if (NOTIFY) {
    // 状态没变也要记下来，避免 signature 漂移
    saveState({ ...state, signature: decision.signature, healthy: status.healthy });
}

if (AS_JSON) {
    console.log(JSON.stringify({ ...status, decision, pushResult }, null, 2));
} else {
    if (status.healthy) {
        console.log(`✅ 同步服务正常（最后一次运行 ${status.hoursSinceLastRun ?? '?'} 小时前）`);
    } else {
        console.log(`❌ 发现 ${status.problems.length} 个问题：`);
        for (const p of status.problems) {
            console.log(`  [${p.level}] ${p.title}`);
            console.log(`         ${p.detail.split('\n')[0]}`);
        }
    }
    if (NOTIFY) {
        console.log(`推送：${decision.send ? (pushResult?.ok ? '已发送' : '发送失败 ' + pushResult?.error) : '跳过（' + decision.reason + '）'}`);
    }
}

process.exit(status.healthy ? 0 : 1);
