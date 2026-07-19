#!/usr/bin/env node
/**
 * 每日简报 · 运动数据同步模块
 *
 * 统计过去 N 小时（默认 24）两个佳明账号「国区 → 国际区」各同步了多少条活动，
 * 供 openclaw「每日简报推送」cron 任务调用，告知当天同步了多少数据。
 *
 * 数据源：GitHub Actions 两个 sync workflow 的运行日志（零侵入，不改同步代码）。
 *   - 账号2 走 EC2 webhook，GitHub 日志里有 webhook 返回的 {"uploadedCount":N}
 *   - 账号1 在 runner 上直接跑，每上传一条打印一行「本次开始向国际区上传第…」
 *
 * 用法：
 *   node scripts/sync-report.js            # 过去 24 小时
 *   SYNC_REPORT_WINDOW_HOURS=48 node ...   # 自定义窗口
 *   node scripts/sync-report.js --json     # 输出 JSON（供程序消费）
 *
 * 依赖：已登录的 gh CLI（gh auth status 正常）。
 */
const { execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const execFileAsync = promisify(execFile);

// 解析 gh 可执行文件路径：cron 的 shell PATH 可能不含 /opt/homebrew/bin，
// 优先用已知绝对路径（确定性），再回退到 PATH 里的 gh。
const GH_BIN = (() => {
    const candidates = [process.env.GH_BIN, '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
    for (const c of candidates) {
        try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return 'gh';
})();

const REPO = process.env.SYNC_REPORT_REPO || 'gaoran1209/dailysync-rev';
const WINDOW_HOURS = Number(process.env.SYNC_REPORT_WINDOW_HOURS || 24);
const SINCE = Date.now() - WINDOW_HOURS * 3600 * 1000;
const AS_JSON = process.argv.includes('--json');

const ACCOUNTS = [
    { label: '账号1', who: 'gaoran24', wf: 'sync_garmin_cn_to_garmin_global.yml', mode: 'account1' },
    { label: '账号2', who: '18380445747', wf: 'sync_garmin_cn_to_garmin_global_account2.yml', mode: 'account2' },
];

function gh(args) {
    try {
        return execFileSync(GH_BIN, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
        // gh 对失败的 run 日志可能返回非 0，但 stdout 里仍有内容
        return (e.stdout && e.stdout.toString()) || '';
    }
}

function runList(wf) {
    const out = gh(['run', 'list', '--repo', REPO, '--workflow', wf, '--limit', '30',
        '--json', 'databaseId,createdAt,status,conclusion']);
    try { return JSON.parse(out); } catch { return []; }
}

function parseCount(log, mode) {
    if (mode === 'account2') {
        // webhook 返回 JSON：{"status":"ok","uploadedCount":4,...}
        const m = log.match(/"uploadedCount":(\d+)/);
        return m ? Number(m[1]) : 0;
    }
    // 账号1：每上传一条活动打印一行
    const matches = log.match(/本次开始向国际区上传第/g);
    return matches ? matches.length : 0;
}

async function logCount(id, mode) {
    try {
        const { stdout } = await execFileAsync(GH_BIN, ['run', 'view', String(id), '--repo', REPO, '--log'],
            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        return parseCount(stdout || '', mode);
    } catch (e) {
        // 失败 run 的日志可能非 0 退出但 stdout 有内容
        return parseCount((e.stdout && e.stdout.toString()) || '', mode);
    }
}

/** 并发执行任务，限制并发数，避免一次打太多 gh 请求 */
async function pool(items, worker, concurrency = 6) {
    const results = new Array(items.length);
    let i = 0;
    async function run() {
        while (i < items.length) {
            const idx = i++;
            results[idx] = await worker(items[idx], idx);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
    return results;
}

async function collect() {
    const perAccount = [];
    let grandTotal = 0;
    let anyFail = false;
    for (const a of ACCOUNTS) {
        const runs = runList(a.wf).filter(
            (r) => r && r.status === 'completed' && new Date(r.createdAt).getTime() >= SINCE,
        );
        const successRuns = runs.filter((r) => r.conclusion === 'success');
        const failed = runs.length - successRuns.length;
        // 各成功 run 的日志并发拉取
        const counts = await pool(successRuns, (r) => logCount(r.databaseId, a.mode));
        const synced = counts.reduce((s, n) => s + (n || 0), 0);
        grandTotal += synced;
        if (failed > 0) anyFail = true;
        perAccount.push({ label: a.label, who: a.who, synced, checks: runs.length, failed });
    }
    return { windowHours: WINDOW_HOURS, perAccount, grandTotal, anyFail };
}

function render(data) {
    const lines = [];
    lines.push(`过去 ${data.windowHours} 小时运动数据同步（国区 → 国际区）`);
    for (const a of data.perAccount) {
        const status = a.failed > 0 ? `⚠️ ${a.failed} 次失败` : (a.checks > 0 ? '✅ 正常' : '— 无运行');
        lines.push(`- ${a.label}(${a.who})：同步 ${a.synced} 条 · ${a.checks} 次检查 · ${status}`);
    }
    lines.push(`合计同步 ${data.grandTotal} 条活动${data.anyFail ? '（存在同步失败，建议检查）' : ''}`);
    return lines.join('\n');
}

// 预检：gh 是否可用且已登录。不可用时明确报错，避免把"取数失败"误报成"同步 0 条"。
function preflight() {
    try {
        execFileSync(GH_BIN, ['auth', 'status'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

if (!preflight()) {
    const msg = '运动数据同步：数据获取失败（gh CLI 未安装或未登录，无法读取 GitHub Actions 运行记录）';
    if (AS_JSON) {
        console.log(JSON.stringify({ error: 'gh_unavailable', message: msg }));
    } else {
        console.log(msg);
    }
    process.exit(0); // 退出 0，让简报能把这行原样展示，而不是整体失败
}

collect().then((data) => {
    console.log(AS_JSON ? JSON.stringify(data) : render(data));
}).catch((e) => {
    console.log(`运动数据同步：统计出错（${String(e && e.message || e).slice(0, 80)}）`);
    process.exit(0);
});
