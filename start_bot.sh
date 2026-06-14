#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p outputs

if [ -f outputs/bot.pid ] && kill -0 "$(cat outputs/bot.pid)" >/dev/null 2>&1; then
  echo "Bot is already running. PID: $(cat outputs/bot.pid)"
  exit 0
fi

nohup npm start > outputs/bot.out.log 2> outputs/bot.err.log &
echo $! > outputs/bot.pid

echo "Bot started. PID: $(cat outputs/bot.pid)"
echo "Logs:"
echo "  tail -f outputs/bot.out.log"
echo "  tail -f outputs/bot.err.log"
