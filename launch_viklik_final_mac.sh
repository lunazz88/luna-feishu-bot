#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.luna.feishu.viklik-final"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

mkdir -p "$PROJECT_DIR/outputs/viklik-final" "$LAUNCH_AGENTS_DIR"
launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME/.local/node-current/bin/node</string>
    <string>$PROJECT_DIR/src/finalBotWsClient.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/node-current/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>FEISHU_AUTOMATION_DIR</key>
    <string>$PROJECT_DIR</string>
    <key>FEISHU_ENV_PATH</key>
    <string>$PROJECT_DIR/.env.viklik.robot2</string>
    <key>FEISHU_DOC_ENV_PATH</key>
    <string>$PROJECT_DIR/.env.viklik.robot1</string>
    <key>CODEX_PYTHON_EXE</key>
    <string>$PROJECT_DIR/.venv/bin/python</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/outputs/viklik-final/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/outputs/viklik-final/launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"

echo "viklik final launchd label: $LABEL"
echo "logs:"
echo "  outputs/viklik-final/launchd.out.log"
echo "  outputs/viklik-final/launchd.err.log"
