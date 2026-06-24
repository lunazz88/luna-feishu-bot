#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="${NODE_BIN:-/Users/congyoubing/.local/node-current/bin/node}"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
ROBOT1_LABEL="com.luna.feishu.robot1"
ROBOT2_LABEL="com.luna.feishu.robot2"
ROBOT1_PLIST="$LAUNCH_AGENTS_DIR/$ROBOT1_LABEL.plist"
ROBOT2_PLIST="$LAUNCH_AGENTS_DIR/$ROBOT2_LABEL.plist"

mkdir -p "$PROJECT_DIR/outputs" "$LAUNCH_AGENTS_DIR"

write_plist() {
  local plist_path="$1"
  local label="$2"
  local script_path="$3"
  local env_path="$4"
  local doc_env_path="${5:-}"
  local stdout_path="$6"
  local stderr_path="$7"

  cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$script_path</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>FEISHU_AUTOMATION_DIR</key>
    <string>$PROJECT_DIR</string>
    <key>FEISHU_ENV_PATH</key>
    <string>$env_path</string>
    <key>FEISHU_DOC_ENV_PATH</key>
    <string>$doc_env_path</string>
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
  <string>$stdout_path</string>
  <key>StandardErrorPath</key>
  <string>$stderr_path</string>
</dict>
</plist>
PLIST
}

launchctl bootout "gui/$UID" "$ROBOT1_PLIST" >/dev/null 2>&1 || true
launchctl bootout "gui/$UID" "$ROBOT2_PLIST" >/dev/null 2>&1 || true

write_plist \
  "$ROBOT1_PLIST" \
  "$ROBOT1_LABEL" \
  "$PROJECT_DIR/src/botWsClient.js" \
  "$PROJECT_DIR/.env.robot1" \
  "" \
  "$PROJECT_DIR/outputs/robot1.launchd.out.log" \
  "$PROJECT_DIR/outputs/robot1.launchd.err.log"

write_plist \
  "$ROBOT2_PLIST" \
  "$ROBOT2_LABEL" \
  "$PROJECT_DIR/src/finalBotWsClient.js" \
  "$PROJECT_DIR/.env.robot2" \
  "$PROJECT_DIR/.env.robot1" \
  "$PROJECT_DIR/outputs/robot2.launchd.out.log" \
  "$PROJECT_DIR/outputs/robot2.launchd.err.log"

launchctl bootstrap "gui/$UID" "$ROBOT1_PLIST"
launchctl bootstrap "gui/$UID" "$ROBOT2_PLIST"
launchctl kickstart -k "gui/$UID/$ROBOT1_LABEL"
launchctl kickstart -k "gui/$UID/$ROBOT2_LABEL"

echo "robot1 launchd label: $ROBOT1_LABEL"
echo "robot2 launchd label: $ROBOT2_LABEL"
echo "logs:"
echo "  outputs/robot1.launchd.out.log"
echo "  outputs/robot1.launchd.err.log"
echo "  outputs/robot2.launchd.out.log"
echo "  outputs/robot2.launchd.err.log"
