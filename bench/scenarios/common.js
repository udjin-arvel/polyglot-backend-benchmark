import http from "k6/http";
import { sleep } from "k6";

export const trendStats = ["med", "p(95)", "p(99)"];

export function scenario(defaultDuration) {
  const rate = parseInt(__ENV.RPS_TARGET || "20", 10);
  const duration = __ENV.BENCH_DURATION || defaultDuration;
  const maxVUs = Math.max(40, rate * 8);
  const preAllocatedVUs = Math.min(maxVUs, Math.max(8, Math.ceil(rate / 2)));
  const shared = {
    timeUnit: "1s",
    preAllocatedVUs,
    maxVUs,
    gracefulStop: "10s",
  };
  if (__ENV.BENCH_MODE === "ramp-up") {
    return {
      executor: "ramping-arrival-rate",
      startRate: 0,
      stages: [{ target: rate, duration }],
      ...shared,
    };
  }
  return {
    executor: "constant-arrival-rate",
    rate,
    duration,
    ...shared,
  };
}

export function warmup(base) {
  const n = parseInt(__ENV.BENCH_WARMUP || "5", 10);
  for (let i = 0; i < n; i++) {
    http.get(`${base}/health`);
    sleep(1);
  }
}
