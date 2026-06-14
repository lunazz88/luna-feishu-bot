#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it first: brew install node"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js first: brew install node"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required. Install it first: brew install python"
  exit 1
fi

npm install

python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r requirements.txt

mkdir -p outputs/incoming

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Fill app id and secret before starting."
fi

npm run check
npm run test:config

echo "Install complete. Start with: ./start_bot.sh"
