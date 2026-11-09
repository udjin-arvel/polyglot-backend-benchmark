#!/bin/bash
set -euo pipefail

RESULTS_DIR="${RESULTS_DIR:-/bench/results}"
SCENARIOS=(read-heavy mixed-crud aggregate)
BACKENDS=(go:backend-go:8081 node:backend-node:8082 php:backend-php-nginx:8083 python:backend-python:8084)
MODES=(fixed-rps ramp-up)
RPS_TARGET="${RPS_TARGET:-20}"
BENCH_WARMUP="${BENCH_WARMUP:-5}"
RUNS="${BENCH_RUNS:-1}"

if [[ "${BENCH_QUICK:-0}" == "1" ]]; then
  SCENARIOS=(read-heavy)
  BACKENDS=(go:backend-go:8081)
  MODES=(fixed-rps)
  RUNS=1
  export BENCH_DURATION=10s
  export RPS_TARGET=10
  export BENCH_WARMUP=1
fi

export BENCH_WARMUP

mkdir -p "$RESULTS_DIR"

median() {
  jq -s 'map(tonumber) | sort | if length == 0 then 0 else .[((length - 1) / 2 | floor)] end'
}

num() {
  jq -r "$1 // 0" "$2"
}

run_k6() {
  local scenario="$1" backend="$2" mode="$3" url="$4" run_idx="$5"
  local summary="/tmp/k6-summary-${scenario}-${backend}-${mode}-${run_idx}.json"
  set +e
  k6 run \
    -e TARGET_URL="$url" \
    -e BENCH_MODE="$mode" \
    -e RPS_TARGET="$RPS_TARGET" \
    -e BENCH_DURATION="${BENCH_DURATION:-}" \
    -e BENCH_WARMUP="${BENCH_WARMUP}" \
    --summary-export="$summary" \
    "/bench/scenarios/${scenario}.js" >/dev/null
  local rc=$?
  set -e
  if [[ $rc -ne 0 && $rc -ne 99 ]]; then
    echo "k6 failed (exit ${rc}): ${scenario} ${backend} ${mode} run ${run_idx}" >&2
    return "$rc"
  fi
  if [[ ! -s "$summary" ]]; then
    echo "k6 wrote no summary: ${scenario} ${backend} ${mode} run ${run_idx}" >&2
    return 1
  fi
  echo "$summary"
}

echo "bench: rps=${RPS_TARGET} runs=${RUNS} warmup=${BENCH_WARMUP}s duration=${BENCH_DURATION:-default} scenarios=${SCENARIOS[*]}"

meta_for() {
  local bname="$1" url="$2"
  local meta="/tmp/meta-${bname}.json"
  if [[ -f "$meta" ]]; then
    return
  fi
  local cold idle image loc=0
  cold=$(/scripts/collect-metrics.sh cold "$bname" "$url" || echo 0)
  sleep 1
  idle=$(/scripts/collect-metrics.sh sample "$bname" | awk '{ print $1 }')
  image=$(/scripts/collect-metrics.sh image "$bname" || echo 0)
  case "$bname" in
    go) loc=$(wc -l < /repo/backends/go/main.go 2>/dev/null || echo 0) ;;
    node) loc=$(wc -l < /repo/backends/node/server.js 2>/dev/null || echo 0) ;;
    php) loc=$(wc -l < /repo/backends/php/index.php 2>/dev/null || echo 0) ;;
    python) loc=$(wc -l < /repo/backends/python/app.py 2>/dev/null || echo 0) ;;
  esac
  jq -n \
    --argjson cold "$cold" \
    --argjson idle "$idle" \
    --argjson image "$image" \
    --argjson loc "$loc" \
    '{cold_start_ms: $cold, rss_idle_mb: $idle, image_mb: $image, loc: $loc}' >"$meta"
  echo "meta ${bname}: idle=${idle} MiB image=${image} MiB cold=${cold} ms"
}

for trip in "${SCENARIOS[@]}"; do
  for be in "${BACKENDS[@]}"; do
    IFS=: read -r bname host port <<<"$be"
    url="http://${host}:${port}"
    meta_for "$bname" "$url"
    for mode in "${MODES[@]}"; do
      lat_p50=()
      lat_p95=()
      lat_p99=()
      rps_actual=()
      failed=()
      samples=$(mktemp)
      (
        while true; do
          /scripts/collect-metrics.sh sample "$bname" >>"$samples" 2>/dev/null || true
          sleep 2
        done
      ) &
      sample_pid=$!
      for ((i = 1; i <= RUNS; i++)); do
        echo "run ${trip} ${bname} ${mode} ${i}/${RUNS}"
        summary=$(run_k6 "$trip" "$bname" "$mode" "$url" "$i")
        lat_p50+=("$(num '.metrics.http_req_duration.med' "$summary")")
        lat_p95+=("$(num '.metrics.http_req_duration["p(95)"]' "$summary")")
        lat_p99+=("$(num '.metrics.http_req_duration["p(99)"]' "$summary")")
        rps_actual+=("$(num '.metrics.http_reqs.rate' "$summary")")
        failed+=("$(num '.metrics.http_req_failed.value' "$summary")")
      done
      kill "$sample_pid" 2>/dev/null || true
      wait "$sample_pid" 2>/dev/null || true
      p50=$(printf '%s\n' "${lat_p50[@]}" | median)
      p95=$(printf '%s\n' "${lat_p95[@]}" | median)
      p99=$(printf '%s\n' "${lat_p99[@]}" | median)
      rps=$(printf '%s\n' "${rps_actual[@]}" | median)
      fail=$(printf '%s\n' "${failed[@]}" | median)
      rss_load=$(awk 'NF { if (($1 + 0) > m) m = $1 + 0 } END { printf "%.1f", m + 0 }' "$samples")
      cpu=$(awk 'NF { s += $2; n++ } END { if (n) printf "%.1f", s / n; else print 0 }' "$samples")
      rm -f "$samples"

      out="${RESULTS_DIR}/${trip}-${bname}-${mode}.json"
      jq -n \
        --arg scenario "$trip" \
        --arg backend "$bname" \
        --arg mode "$mode" \
        --argjson rps_target "$RPS_TARGET" \
        --argjson rps_actual "$rps" \
        --argjson p50 "$p50" \
        --argjson p95 "$p95" \
        --argjson p99 "$p99" \
        --argjson failed "$fail" \
        --argjson runs "$RUNS" \
        --argjson rss_load "$rss_load" \
        --argjson cpu "$cpu" \
        --slurpfile meta "/tmp/meta-${bname}.json" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
          scenario: $scenario,
          backend: $backend,
          mode: $mode,
          rps_target: $rps_target,
          rps_actual: ($rps_actual * 10 | round / 10),
          latency: {
            p50: ($p50 * 10 | round / 10),
            p95: ($p95 * 10 | round / 10),
            p99: ($p99 * 10 | round / 10)
          },
          failed_pct: ($failed * 1000 | round / 10),
          runs: $runs,
          rss_mb: $rss_load,
          rss_idle_mb: $meta[0].rss_idle_mb,
          cpu_pct: $cpu,
          image_mb: $meta[0].image_mb,
          loc: $meta[0].loc,
          cold_start_ms: $meta[0].cold_start_ms,
          timestamp: $ts
        }' >"$out"
      echo "wrote $out  rps=$(jq -r .rps_actual "$out") p50=$(jq -r .latency.p50 "$out") rss=$(jq -r .rss_mb "$out") cpu=$(jq -r .cpu_pct "$out")"
    done
  done
done

if [[ "${BENCH_QUICK:-0}" != "1" ]]; then
  /scripts/publish-bench-results.sh "$RESULTS_DIR" || true
fi
