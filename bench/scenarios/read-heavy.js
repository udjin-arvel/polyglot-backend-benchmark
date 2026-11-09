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
  const offset = Math.floor(Math.random() * Math.max(1, data.maxId - 20));
  if (Math.random() < 0.95) {
    http.get(`${base}/items?limit=20&offset=${offset}`);
  } else {
    const id = 1 + Math.floor(Math.random() * data.maxId);
    http.get(`${base}/items/${id}`);
  }
}
