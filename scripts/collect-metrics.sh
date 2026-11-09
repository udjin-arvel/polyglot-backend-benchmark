#!/bin/sh
# Runtime metrics via the Docker Engine API.
#   collect-metrics.sh sample <backend>     -> "rss_mb cpu_pct"
#   collect-metrics.sh image  <backend>     -> image size, MiB
#   collect-metrics.sh cold   <backend> <url> -> ms from restart to /health
set -eu

mode="${1:-sample}"
bname="${2:-go}"
url="${3:-}"
sock="${DOCKER_SOCK:-/var/run/docker.sock}"

zero() {
  case "$mode" in
    sample) printf '0 0\n' ;;
    *) printf '0\n' ;;
  esac
}

if [ ! -S "$sock" ]; then
  zero
  exit 0
fi

api() {
  curl -sf --unix-socket "$sock" "$@"
}

services() {
  printf 'backend-%s\n' "$bname"
  if [ "$bname" = "php" ]; then
    printf 'backend-php-nginx\n'
  fi
}

cids() {
  raw=$(api "http://localhost/containers/json") || return 0
  services | while read -r svc; do
    printf '%s\n' "$raw" | jq -r --arg svc "$svc" '.[] | select(.Labels["com.docker.compose.service"] == $svc) | .Id'
  done
}

sample() {
  mem=0
  cpu=0
  n=0
  ids=$(cids)
  if [ -z "$ids" ]; then
    printf '0 0\n'
    return
  fi
  for id in $ids; do
    stats=$(api "http://localhost/containers/${id}/stats?stream=false") || continue
    pair=$(printf '%s' "$stats" | jq -r '
      . as $s
      | ($s.memory_stats.usage // 0) as $u
      | ($s.memory_stats.stats.inactive_file // 0) as $inactive
      | (if $u > $inactive then $u - $inactive else 0 end) as $mem
      | ($s.cpu_stats.cpu_usage.total_usage // 0) as $c
      | ($s.precpu_stats.cpu_usage.total_usage // 0) as $pc
      | ($s.cpu_stats.system_cpu_usage // 0) as $sys
      | ($s.precpu_stats.system_cpu_usage // 0) as $psys
      | ($s.cpu_stats.online_cpus // 1) as $cores
      | (if ($sys - $psys) > 0 then (($c - $pc) / ($sys - $psys) * $cores * 100) else 0 end) as $cpu
      | "\($mem) \($cpu)"
    ' 2>/dev/null || true)
    [ -n "$pair" ] || continue
    set -- $pair
    mem=$(awk -v a="$mem" -v b="$1" 'BEGIN { printf "%.0f", a + b }')
    cpu=$(awk -v a="$cpu" -v b="$2" 'BEGIN { printf "%.4f", a + b }')
    n=$((n + 1))
  done
  awk -v m="$mem" -v c="$cpu" 'BEGIN { printf "%.1f %.1f\n", m / 1048576, c }'
}

image_mb() {
  total=0
  ids=$(cids)
  if [ -z "$ids" ]; then
    printf '0\n'
    return
  fi
  for id in $ids; do
    name=$(api "http://localhost/containers/${id}/json" | jq -r '.Config.Image // empty') || continue
    [ -n "$name" ] || continue
    size=$(api "http://localhost/images/${name}/json" | jq -r '.Size // 0') || size=0
    total=$(awk -v a="$total" -v b="$size" 'BEGIN { printf "%.0f", a + b }')
  done
  awk -v t="$total" 'BEGIN { printf "%.1f\n", t / 1048576 }'
}

cold_ms() {
  app=$(api "http://localhost/containers/json" | jq -r --arg svc "backend-${bname}" '.[] | select(.Labels["com.docker.compose.service"] == $svc) | .Id' | head -n 1)
  if [ -z "$app" ] || [ -z "$url" ]; then
    printf '0\n'
    return
  fi
  start=$(awk '{ print $1 }' /proc/uptime)
  api -X POST "http://localhost/containers/${app}/restart?t=2" >/dev/null || true
  i=0
  while [ "$i" -lt 150 ]; do
    if curl -sf --max-time 1 "${url}/health" >/dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
    sleep 0.05
  done
  end=$(awk '{ print $1 }' /proc/uptime)
  awk -v s="$start" -v e="$end" 'BEGIN { printf "%.0f\n", (e - s) * 1000 }'
}

case "$mode" in
  sample) sample ;;
  image) image_mb ;;
  cold) cold_ms ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
