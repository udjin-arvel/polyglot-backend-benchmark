#!/bin/sh
set -eu
service="${1:-backend-go}"
port="${2:-8081}"
start=$(date +%s%3N)
until wget -qO- "http://127.0.0.1:${port}/health" >/dev/null 2>&1; do
  sleep 0.2
done
end=$(date +%s%3N)
echo $((end - start))
