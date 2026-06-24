#!/usr/bin/env bash
set -euo pipefail

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

for label in com.luna.feishu.robot1 com.luna.feishu.robot2; do
  plist="$LAUNCH_AGENTS_DIR/$label.plist"
  launchctl bootout "gui/$UID" "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
  echo "stopped $label"
done
