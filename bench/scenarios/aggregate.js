import http from "k6/http";
import { sleep } from "k6";

const base = __ENV.TARGET_URL;

export const options = {
  scenarios: {
    bench: __ENV.BENCH_MODE === "ramp-up"
      ? {
          executor: "ramping-arrival-rate",
          startRate: 0,
          timeUnit: "1s",
          preAllocatedVUs: 50,
          maxVUs: 200,
          stages: [{ target: parseInt(__ENV.RPS_TARGET || "200", 10), duration: __ENV.BENCH_DURATION || "1m" }],
        }
      : {
          executor: "constant-arrival-rate",
          rate: parseInt(__ENV.RPS_TARGET || "200", 10),
          timeUnit: "1s",
          duration: __ENV.BENCH_DURATION || "1m",
          preAllocatedVUs: 50,
          maxVUs: 200,
        },
  },
};

export function setup() {
  for (let i = 0; i < 30; i++) {
    http.get(`${base}/health`);
    sleep(1);
  }
}

export default function () {
  http.get(`${base}/stats`);
}
