#!/usr/bin/env bash
set -euo pipefail

LABEL="com.luna.feishu.viklik-xmp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$UID" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
echo "stopped $LABEL"
