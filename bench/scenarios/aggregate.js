import http from "k6/http";
import { scenario, trendStats, warmup } from "./common.js";

const base = __ENV.TARGET_URL;

export const options = {
  summaryTrendStats: trendStats,
  scenarios: { bench: scenario("20s") },
};

export function setup() {
  warmup(base);
}

export default function () {
  http.get(`${base}/stats`);
}
