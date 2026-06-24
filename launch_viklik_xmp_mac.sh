#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${NODE_BIN:-/Users/congyoubing/.local/node-current/bin/node}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LABEL="com.luna.feishu.viklik-xmp"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"

mkdir -p "$PROJECT_DIR/outputs/viklik-xmp" "$LAUNCH_AGENTS_DIR"

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
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/src/viklikXmpMorningBot.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FEISHU_AUTOMATION_DIR</key>
    <string>$PROJECT_DIR</string>
    <key>FEISHU_ENV_PATH</key>
    <string>$PROJECT_DIR/.env.viklik.robot1</string>
    <key>FEISHU_DOC_ENV_PATH</key>
    <string>$PROJECT_DIR/.env.viklik.robot1</string>
    <key>CODEX_PYTHON_EXE</key>
    <string>$PROJECT_DIR/.venv/bin/python</string>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$PROJECT_DIR/outputs/viklik-xmp/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$PROJECT_DIR/outputs/viklik-xmp/launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl bootstrap "gui/$UID" "$PLIST"
launchctl kickstart -k "gui/$UID/$LABEL"

echo "viklik xmp launchd label: $LABEL"
echo "logs:"
echo "  outputs/viklik-xmp/launchd.out.log"
echo "  outputs/viklik-xmp/launchd.err.log"
