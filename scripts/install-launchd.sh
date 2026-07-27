#!/bin/bash
#
# 安装/更新定时任务（每天 0/6/12/18 点，本地时间）。
#   scripts/install-launchd.sh            安装或更新
#   scripts/install-launchd.sh uninstall  卸载
#
# 用 LaunchAgent 而不是 LaunchDaemon：账号2 的重新登录要开真实浏览器窗口，
# 需要 GUI 会话。用 StartCalendarInterval 而不是 StartInterval：睡眠期间错过的
# 触发点，launchd 会在唤醒后补跑一次（StartInterval 错过就是永久丢失）。
#
set -euo pipefail

LABEL="xyz.gaoran.dailysync"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA_DIR="${DAILYSYNC_DATA_DIR:-$HOME/.dailysync}"
UID_NUM="$(id -u)"

if [ "${1:-}" = "uninstall" ]; then
    launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "✅ 已卸载 $LABEL"
    exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$DATA_DIR/logs"
chmod +x "$REPO_DIR/scripts/run-sync.sh"

cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO_DIR/scripts/run-sync.sh</string>
    </array>

    <key>StartCalendarInterval</key>
    <array>
        <dict><key>Hour</key><integer>0</integer><key>Minute</key><integer>20</integer></dict>
        <dict><key>Hour</key><integer>6</integer><key>Minute</key><integer>20</integer></dict>
        <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>20</integer></dict>
        <dict><key>Hour</key><integer>18</integer><key>Minute</key><integer>20</integer></dict>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>$DATA_DIR/logs/launchd.out.log</string>
    <key>StandardErrorPath</key>
    <string>$DATA_DIR/logs/launchd.err.log</string>

    <key>ProcessType</key>
    <string>Background</string>
</dict>
</plist>
PLISTEOF

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"

echo "✅ 已安装 $LABEL"
echo "   plist:  $PLIST"
echo "   日志:   $DATA_DIR/logs/"
echo "   立即跑一次: launchctl kickstart -k gui/$UID_NUM/$LABEL"
echo "   查看状态:   launchctl print gui/$UID_NUM/$LABEL | head -20"
