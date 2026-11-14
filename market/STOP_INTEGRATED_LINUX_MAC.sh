#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh ./STOP_ALL_LINUX_MAC.sh
sh ./market/STOP_ALL.sh
