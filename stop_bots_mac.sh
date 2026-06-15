#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

stop_one() {
  local name="$1"
  local pid_file="outputs/${name}.pid"
  if [ ! -f "$pid_file" ]; then
    echo "$name is not running: pid file missing"
    return
  fi
  local pid
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill "$pid"
    echo "$name stopped: $pid"
  else
    echo "$name is not running: $pid"
  fi
  rm -f "$pid_file"
}

stop_one robot1
stop_one robot2
