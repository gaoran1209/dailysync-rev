#!/usr/bin/env node
/**
 * 每日简报 · 运动数据同步模块
 *
 * 统计过去 N 小时（默认 24）两个佳明账号「国区 → 国际区」各同步了多少条活动，
 * 供 openclaw「每日简报推送」调用。
 *
 * 数据源：~/.dailysync/logs/sync-*.log 里 src/sync.ts 打的 [SYNC-RESULT] {...} 行。
 * （以前是去扒 GitHub Actions 的日志，同步搬回本机之后改成读本地日志，不再依赖 gh。）
 *
 * 用法：
 *   node scripts/sync-report.js            # 过去 24 小时，输出中文文本
 *   node scripts/sync-report.js --json     # 输出 JSON，供程序消费
 *   SYNC_REPORT_WINDOW_HOURS=48 node scripts/sync-report.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = process.env.DAILYSYNC_DATA_DIR || path.join(os.homedir(), '.dailysync');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const WINDOW_HOURS = Number(process.env.SYNC_REPORT_WINDOW_HOURS || 24);
const SINCE = Date.now() - WINDOW_HOURS * 3600 * 1000;
const AS_JSON = process.argv.includes('--json');

const ACCOUNT_LABELS = { 1: '账号1', 2: '账号2' };

function readResults() {
    if (!fs.existsSync(LOG_DIR)) return [];
    const results = [];
    // 只读窗口可能覆盖到的那几天的日志文件
    const keepFiles = Math.max(2, Math.ceil(WINDOW_HOURS / 24) + 1);
    const files = fs.readdirSync(LOG_DIR)
        .filter(f => /^sync-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort()
        .slice(-keepFiles);

    for (const file of files) {
        let content;
        try {
            content = fs.readFileSync(path.join(LOG_DIR, file), 'utf8');
        } catch {
            continue;
        }
        for (const line of content.split('\n')) {
            const idx = line.indexOf('[SYNC-RESULT]');
            if (idx === -1) continue;
            try {
                const parsed = JSON.parse(line.slice(idx + '[SYNC-RESULT]'.length).trim());
                const at = parsed.at ? Date.parse(parsed.at) : NaN;
                if (Number.isFinite(at) && at < SINCE) continue;
                results.push(parsed);
            } catch {
                /* 半行日志之类，跳过 */
            }
        }
    }
    return results;
}

function summarize(results) {
    const summary = {};
    for (const id of ['1', '2']) {
        const mine = results.filter(r => String(r.account) === id);
        const last = mine.length ? mine[mine.length - 1] : null;
        summary[id] = {
            label: ACCOUNT_LABELS[id],
            checks: mine.length,
            synced: mine.reduce((sum, r) => sum + (Number(r.uploadedCount) || 0), 0),
            lastStatus: last ? last.status : null,
            lastMessage: last ? last.message : null,
            needsAttention: mine.some(r => r.status === 'reauth_required' || r.status === 'failed'),
        };
    }
    return summary;
}

function render(summary) {
    const lines = [`过去 ${WINDOW_HOURS} 小时运动数据同步（国区 → 国际区）`];
    let total = 0;
    let anyProblem = false;
    for (const id of ['1', '2']) {
        const s = summary[id];
        total += s.synced;
        if (!s.checks) {
            lines.push(`- ${s.label}：— 无运行记录（定时任务可能没跑）`);
            anyProblem = true;
            continue;
        }
        if (s.needsAttention) {
            anyProblem = true;
            lines.push(`- ${s.label}：同步 ${s.synced} 条 · ${s.checks} 次检查 · ⚠️ ${s.lastMessage}`);
        } else {
            lines.push(`- ${s.label}：同步 ${s.synced} 条 · ${s.checks} 次检查 · ✅ 正常`);
        }
    }
    lines.push(`合计同步 ${total} 条活动${anyProblem ? '（有需要处理的问题，见上）' : ''}`);
    return lines.join('\n');
}

const results = readResults();
const summary = summarize(results);

if (AS_JSON) {
    console.log(JSON.stringify({ windowHours: WINDOW_HOURS, summary, results }, null, 2));
} else {
    console.log(render(summary));
}
