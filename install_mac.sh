#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Missing node. Install it first, for example: brew install node"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Missing npm. Install Node.js first."
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Missing python3. Install it first, for example: brew install python"
  exit 1
fi

npm install
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
mkdir -p outputs

chmod +x start_robot1_mac.sh start_robot2_mac.sh start_all_mac.sh stop_bots_mac.sh

echo "Install complete."
echo "Run ./start_all_mac.sh to start robot1 and robot2."
