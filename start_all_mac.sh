#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"
./start_robot1_mac.sh
./start_robot2_mac.sh
