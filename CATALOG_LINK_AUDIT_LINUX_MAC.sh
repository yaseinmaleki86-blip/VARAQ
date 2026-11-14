#!/bin/sh
set -eu
cd "$(dirname "$0")"
python3 market/CATALOG_LINK_V98.py
