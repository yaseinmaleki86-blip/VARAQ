#!/bin/sh
set -eu
cd "$(dirname "$0")"
VARAQ_CURATED_SEED=1 node server.js
