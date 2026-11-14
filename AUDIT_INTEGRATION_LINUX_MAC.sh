#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ -n "${DATA_DIR:-}" ]; then
  python3 tools/audit-integrated-v97.py --node-db "$DATA_DIR/varaq.sqlite"
else
  python3 tools/audit-integrated-v97.py
fi
