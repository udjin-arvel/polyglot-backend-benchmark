#!/bin/bash
set -euo pipefail

RESULTS_DIR="${RESULTS_DIR:-/bench/results}"
SCENARIOS=(read-heavy mixed-crud aggregate)
BACKENDS=(go:backend-go:8081 node:backend-node:8082 php:backend-php-nginx:8083 python:backend-python:8084)
MODES=(fixed-rps ramp-up)
RPS_TARGET="${RPS_TARGET:-200}"

if [[ "${BENCH_QUICK:-0}" == "1" ]]; then
  SCENARIOS=(read-heavy)
  BACKENDS=(go:backend-go:8081)
  MODES=(fixed-rps)
  RUNS=1
  export BENCH_DURATION=10s
  export RPS_TARGET=50
else
  RUNS=3
fi

mkdir -p "$RESULTS_DIR"

median() {
  jq -s 'sort | if length == 0 then empty else .[((length - 1) / 2 | floor)] end' <<<"$1"
}

run_k6() {
  local scenario="$1" backend="$2" mode="$3" url="$4" run_idx="$5"
  local summary="/tmp/k6-summary-${scenario}-${backend}-${mode}-${run_idx}.json"
  k6 run \
    -e TARGET_URL="$url" \
    -e BENCH_MODE="$mode" \
    -e RPS_TARGET="$RPS_TARGET" \
  -e BENCH_DURATION="${BENCH_DURATION:-}" \
    --summary-export="$summary" \
    "/bench/scenarios/${scenario}.js" >/dev/null
  echo "$summary"
}

for trip in "${SCENARIOS[@]}"; do
  for be in "${BACKENDS[@]}"; do
    IFS=: read -r bname host port <<<"$be"
    url="http://${host}:${port}"
    for mode in "${MODES[@]}"; do
      lat_p50=()
      lat_p95=()
      lat_p99=()
      rps_actual=()
      for ((i = 1; i <= RUNS; i++)); do
        summary=$(run_k6 "$trip" "$bname" "$mode" "$url" "$i")
        lat_p50+=("$(jq -r '.metrics["http_req_duration"].values["p(50)"]' "$summary")")
        lat_p95+=("$(jq -r '.metrics["http_req_duration"].values["p(95)"]' "$summary")")
        lat_p99+=("$(jq -r '.metrics["http_req_duration"].values["p(99)"]' "$summary")")
        rps_actual+=("$(jq -r '.metrics.http_reqs.values.rate' "$summary")")
      done
      p50=$(median "$(printf '%s\n' "${lat_p50[@]}" | jq -R . | jq -s .)")
      p95=$(median "$(printf '%s\n' "${lat_p95[@]}" | jq -R . | jq -s .)")
      p99=$(median "$(printf '%s\n' "${lat_p99[@]}" | jq -R . | jq -s .)")
      rps=$(median "$(printf '%s\n' "${rps_actual[@]}" | jq -R . | jq -s .)")

      extra=$({ /scripts/collect-metrics.sh "$bname" "$host" 2>/dev/null || true; })

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
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
          scenario: $scenario,
          backend: $backend,
          mode: $mode,
          rps_target: $rps_target,
          rps_actual: $rps_actual,
          latency: {p50: $p50, p95: $p95, p99: $p99},
          rss_mb: 0,
          rss_idle_mb: 0,
          cpu_pct: 0,
          timestamp: $ts
        }' >"$out"
      if [[ -f "/tmp/metrics-${bname}.json" ]]; then
        jq -s '.[0] * .[1]' "$out" "/tmp/metrics-${bname}.json" >"${out}.tmp" && mv "${out}.tmp" "$out"
      fi
      echo "wrote $out"
    done
  done
done

if [[ "${BENCH_QUICK:-0}" != "1" ]]; then
  /scripts/publish-bench-results.sh "$RESULTS_DIR" || true
fi
