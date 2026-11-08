#!/bin/sh
set -eu
export NITRO_PORT=3000
export PORT=3000
export HOST=127.0.0.1
node /app/.output/server/index.mjs &
nginx -g "daemon off;"
