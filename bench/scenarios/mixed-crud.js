import http from "k6/http";
import { check, sleep } from "k6";

const base = __ENV.TARGET_URL;

export const options = {
  scenarios: {
    bench: __ENV.BENCH_MODE === "ramp-up"
      ? {
          executor: "ramping-arrival-rate",
          startRate: 0,
          timeUnit: "1s",
          preAllocatedVUs: 100,
          maxVUs: 400,
          stages: [
            { target: parseInt(__ENV.RPS_TARGET || "200", 10), duration: __ENV.BENCH_DURATION || "2m" },
          ],
        }
      : {
          executor: "constant-arrival-rate",
          rate: parseInt(__ENV.RPS_TARGET || "200", 10),
          timeUnit: "1s",
          duration: __ENV.BENCH_DURATION || "2m",
          preAllocatedVUs: 100,
          maxVUs: 400,
        },
  },
};

export function setup() {
  for (let i = 0; i < 30; i++) {
    http.get(`${base}/health`);
    sleep(1);
  }
  return { maxId: 100000 };
}

export default function (data) {
  const r = Math.random();
  if (r < 0.6) {
    const offset = Math.floor(Math.random() * Math.max(1, data.maxId - 20));
    http.get(`${base}/items?limit=20&offset=${offset}`);
  } else if (r < 0.8) {
    http.post(
      `${base}/items`,
      JSON.stringify({
        title: `bench-${Date.now()}`,
        price: "9.99",
        category: "books",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } else if (r < 0.9) {
    const id = 1 + Math.floor(Math.random() * data.maxId);
    http.put(
      `${base}/items/${id}`,
      JSON.stringify({ title: "bench-update", price: "10.00", category: "books" }),
      { headers: { "Content-Type": "application/json" } },
    );
  } else {
    const id = 1 + Math.floor(Math.random() * data.maxId);
    http.del(`${base}/items/${id}`);
  }
}
