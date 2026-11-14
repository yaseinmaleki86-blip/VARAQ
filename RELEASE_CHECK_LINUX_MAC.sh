#!/bin/sh
set -eu
cd "$(dirname "$0")"
node verify-release.js
node preflight.js
node recovery-rehearsal.js
printf '%s\n' 'Package and backup rehearsal completed. NOT approved for paid sales.'
