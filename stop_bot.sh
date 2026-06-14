#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f outputs/bot.pid ]; then
  echo "No PID file found."
  exit 0
fi

PID="$(cat outputs/bot.pid)"
if kill -0 "$PID" >/dev/null 2>&1; then
  kill "$PID"
  echo "Stopped bot. PID: $PID"
else
  echo "Bot process is not running. PID file was stale."
fi

rm -f outputs/bot.pid
