import http from "k6/http";
import { scenario, trendStats, warmup } from "./common.js";

const base = __ENV.TARGET_URL;

export const options = {
  summaryTrendStats: trendStats,
  scenarios: { bench: scenario("30s") },
};

export function setup() {
  warmup(base);
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
