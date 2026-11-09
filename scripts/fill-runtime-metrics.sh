#!/bin/sh
# Fill RSS, CPU, image size and cold-start in existing bench JSON.
# Load figures come from a fresh 10s read-heavy run, not the original matrix.
set -eu

dirs="${BENCH_DIRS:-/data/results /data/public}"
backends="go:backend-go:8081 node:backend-node:8082 php:backend-php-nginx:8083 python:backend-python:8084"

for spec in $backends; do
  name=${spec%%:*}
  rest=${spec#*:}
  host=${rest%%:*}
  port=${rest#*:}
  url="http://${host}:${port}"

  echo "cold-start ${name}"
  cold=$(/scripts/collect-metrics.sh cold "$name" "$url")
  sleep 1
  idle=$(/scripts/collect-metrics.sh sample "$name" | awk '{ print $1 }')
  image=$(/scripts/collect-metrics.sh image "$name")

  echo "load ${name}"
  samples=$(mktemp)
  k6 run \
    -e TARGET_URL="$url" \
    -e BENCH_MODE=fixed-rps \
    -e RPS_TARGET=20 \
    -e BENCH_DURATION=10s \
    -e BENCH_WARMUP=0 \
    /bench/scenarios/read-heavy.js >/dev/null &
  kpid=$!
  sleep 2
  i=0
  while [ "$i" -lt 4 ]; do
    /scripts/collect-metrics.sh sample "$name" >>"$samples" || true
    i=$((i + 1))
    sleep 2
  done
  wait "$kpid" || true

  load=$(awk 'NF { if (($1 + 0) > m) m = $1 + 0 } END { printf "%.1f", m + 0 }' "$samples")
  cpu=$(awk 'NF { s += $2; n++ } END { if (n) printf "%.1f", s / n; else print 0 }' "$samples")
  rm -f "$samples"
  echo "${name}: idle=${idle} load=${load} cpu=${cpu} image=${image} cold=${cold}"

  for dir in $dirs; do
    for f in "$dir"/*-"${name}"-*.json; do
      [ -f "$f" ] || continue
      tmp=$(mktemp)
      jq \
        --argjson idle "$idle" \
        --argjson load "$load" \
        --argjson cpu "$cpu" \
        --argjson image "$image" \
        --argjson cold "$cold" \
        '.rss_idle_mb = $idle | .rss_mb = $load | .cpu_pct = $cpu | .image_mb = $image | .cold_start_ms = $cold' \
        "$f" >"$tmp"
      mv "$tmp" "$f"
    done
  done
done
