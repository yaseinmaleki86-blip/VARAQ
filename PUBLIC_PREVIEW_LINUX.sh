#!/bin/sh
# A guarded public preview launch; MUST pass the real release preflight.
set -eu
cd "$(dirname "$0")"
: "${PUBLIC_URL:?Set PUBLIC_URL to your production HTTPS origin}"
: "${DATA_DIR:?Use a persistent storage directory outside the public web root}"
case "$PUBLIC_URL" in https://*) ;; *) echo 'PUBLIC_URL must begin with https://' >&2; exit 1 ;; esac
if [ "${HOST:-127.0.0.1}" != "127.0.0.1" ]; then
 echo 'Public preview must bind to 127.0.0.1 behind a trusted HTTPS reverse proxy' >&2; exit 1
fi
node preflight.js --strict-preview
exec node server.js
