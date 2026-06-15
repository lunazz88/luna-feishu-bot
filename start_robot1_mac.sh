#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p outputs

export FEISHU_AUTOMATION_DIR="$PWD"
export FEISHU_ENV_PATH="$PWD/.env.robot1"
export CODEX_PYTHON_EXE="$PWD/.venv/bin/python"
unset FEISHU_DOC_ENV_PATH

if [ -f outputs/robot1.pid ] && kill -0 "$(cat outputs/robot1.pid)" >/dev/null 2>&1; then
  echo "robot1 is already running: $(cat outputs/robot1.pid)"
  exit 0
fi

nohup node src/botWsClient.js > outputs/robot1.out.log 2> outputs/robot1.err.log &
echo $! > outputs/robot1.pid
echo "robot1 started: $(cat outputs/robot1.pid)"
echo "logs: outputs/robot1.out.log outputs/robot1.err.log"
