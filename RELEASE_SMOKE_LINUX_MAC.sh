#!/bin/sh
set -eu
cd "$(dirname "$0")"
node release-smoke.js "$@"
