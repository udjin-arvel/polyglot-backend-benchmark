#!/bin/sh
set -eu
bname="$1"
service="$2"

rss_idle_mb=0
cpu_pct=0
image_mb=0
loc=0
cold_start_ms=0

if command -v docker >/dev/null 2>&1; then
  cname=$(docker ps --format '{{.Names}}' | grep -E "${service}|backend-${bname}" | head -n 1 || true)
  if [ -n "$cname" ]; then
    line=$(docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}}' "$cname" 2>/dev/null || true)
    if [ -n "$line" ]; then
      rss_idle_mb=$(printf '%s' "$line" | awk '{print $1}' | sed 's/MiB.*//')
      cpu_pct=$(printf '%s' "$line" | awk '{print $2}' | tr -d '%')
    fi
    img=$(docker inspect -f '{{.Size}}' "$(docker inspect -f '{{.Image}}' "$cname")" 2>/dev/null || echo 0)
    image_mb=$(awk "BEGIN {printf \"%.1f\", ${img:-0}/1024/1024}")
  fi
fi

case "$bname" in
  go) loc=$(wc -l < /repo/backends/go/main.go 2>/dev/null || echo 0) ;;
  node) loc=$(wc -l < /repo/backends/node/server.js 2>/dev/null || echo 0) ;;
  php) loc=$(wc -l < /repo/backends/php/index.php 2>/dev/null || echo 0) ;;
  python) loc=$(wc -l < /repo/backends/python/app.py 2>/dev/null || echo 0) ;;
esac

jq -n \
  --argjson rss_idle_mb "${rss_idle_mb:-0}" \
  --argjson rss_mb "${rss_idle_mb:-0}" \
  --argjson cpu_pct "${cpu_pct:-0}" \
  --argjson image_mb "${image_mb:-0}" \
  --argjson loc "${loc:-0}" \
  --argjson cold_start_ms "${cold_start_ms:-0}" \
  '{rss_idle_mb: $rss_idle_mb, rss_mb: $rss_mb, cpu_pct: $cpu_pct, image_mb: $image_mb, loc: $loc, cold_start_ms: $cold_start_ms}' \
  >"/tmp/metrics-${bname}.json"
