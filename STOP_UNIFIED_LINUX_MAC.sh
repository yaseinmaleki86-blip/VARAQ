#!/bin/sh
set -eu
cd "$(dirname "$0")"
node stop-all.js || true
python3 market/STOP_ALL.py || true
