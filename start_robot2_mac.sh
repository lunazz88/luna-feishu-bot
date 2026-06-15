#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p outputs

export FEISHU_AUTOMATION_DIR="$PWD"
export FEISHU_ENV_PATH="$PWD/.env.robot2"
export FEISHU_DOC_ENV_PATH="$PWD/.env.robot1"
export CODEX_PYTHON_EXE="$PWD/.venv/bin/python"

if [ -f outputs/robot2.pid ] && kill -0 "$(cat outputs/robot2.pid)" >/dev/null 2>&1; then
  echo "robot2 is already running: $(cat outputs/robot2.pid)"
  exit 0
fi

nohup node src/finalBotWsClient.js > outputs/robot2.out.log 2> outputs/robot2.err.log &
echo $! > outputs/robot2.pid
echo "robot2 started: $(cat outputs/robot2.pid)"
echo "logs: outputs/robot2.out.log outputs/robot2.err.log"
