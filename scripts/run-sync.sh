#!/bin/bash
#
# launchd 调用的包装脚本。直接跑也可以：scripts/run-sync.sh [1|2]
#
# 它负责 launchd 环境里没有、但无人值守必须有的东西：
#   - 绝对路径的 node（launchd 的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin）
#   - 互斥锁（上一轮没跑完时不要叠上去）
#   - 硬超时（这台机器上没有 flock/timeout 命令，都是手写的）
#   - 日志落盘 + 按天轮转
#
set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DAILYSYNC_DATA_DIR:-$HOME/.dailysync}"
LOG_DIR="$DATA_DIR/logs"
LOCK_DIR="$DATA_DIR/sync.lock"
TIMEOUT_SECONDS="${DAILYSYNC_TIMEOUT_SECONDS:-900}"
LOG_KEEP_DAYS="${DAILYSYNC_LOG_KEEP_DAYS:-14}"

# node 的位置：优先 Homebrew（路径稳定），否则回退到 PATH 里能找到的
NODE_BIN="${DAILYSYNC_NODE_BIN:-/opt/homebrew/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
    NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "找不到 node，请设置 DAILYSYNC_NODE_BIN" >&2
    exit 127
fi

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/sync-$(date +%Y-%m-%d).log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# ---- 互斥：mkdir 是原子操作，比 lock 文件可靠 ----
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    STALE_PID="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo '')"
    if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; then
        log "上一轮同步（pid $STALE_PID）还在跑，本次跳过"
        exit 0
    fi
    log "发现残留的锁（pid=${STALE_PID:-未知}，进程已不在），清理后继续"
    rm -rf "$LOCK_DIR"
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
        log "抢锁失败，本次跳过"
        exit 0
    fi
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

# ---- 代理会把出站流量绕到别的出口；同步一律走系统默认路由 ----
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy

log "===== 开始同步 ${*:-全部账号} (node $("$NODE_BIN" -v)) ====="

"$NODE_BIN" "$REPO_DIR/dist/sync.js" "$@" >> "$LOG_FILE" 2>&1 &
CHILD_PID=$!

# ---- 手写超时：每秒看一次，超时先 TERM 再 KILL ----
ELAPSED=0
while kill -0 "$CHILD_PID" 2>/dev/null; do
    if [ "$ELAPSED" -ge "$TIMEOUT_SECONDS" ]; then
        log "同步超过 ${TIMEOUT_SECONDS}s 仍未结束，强制终止"
        kill -TERM "$CHILD_PID" 2>/dev/null
        sleep 5
        kill -KILL "$CHILD_PID" 2>/dev/null
        wait "$CHILD_PID" 2>/dev/null
        log "===== 本次同步被超时终止 ====="
        exit 124
    fi
    sleep 1
    ELAPSED=$((ELAPSED + 1))
done

wait "$CHILD_PID"
EXIT_CODE=$?
log "===== 同步结束，退出码 $EXIT_CODE ====="

# ---- 日志轮转 ----
find "$LOG_DIR" -name 'sync-*.log' -type f -mtime "+$LOG_KEEP_DAYS" -delete 2>/dev/null

exit $EXIT_CODE
