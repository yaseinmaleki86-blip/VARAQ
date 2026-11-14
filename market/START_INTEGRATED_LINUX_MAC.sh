#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if ! command -v node >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1; then
 echo "Node.js 22.13+ and Python 3.10+ required" >&2; exit 1
fi
( cd market && python3 FIRST_RUN.py ) &
node server.js
