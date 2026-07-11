#!/usr/bin/env node
import { performance } from "node:perf_hooks";
import { buildApp } from "../apps/gateway/dist/app.js";
import { defaultConfig } from "../packages/config/dist/index.js";

const totalRequests = Number(process.env.POLYMIND_BENCH_REQUESTS ?? "20");
const concurrency = Number(process.env.POLYMIND_BENCH_CONCURRENCY ?? "4");
const latencies = [];
let successfulRequests = 0;
let failedRequests = 0;

const { app } = await buildApp({
  ...defaultConfig,
  logging: { level: "silent" },
  storage: { sqlitePath: ":memory:", storeRequestContent: false }
});

const started = performance.now();
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < totalRequests) {
      next += 1;
      const requestStarted = performance.now();
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "polymind/auto",
          messages: [{ role: "user", content: "benchmark smoke" }]
        }
      });
      latencies.push(performance.now() - requestStarted);
      if (response.statusCode === 200) successfulRequests += 1;
      else failedRequests += 1;
    }
  })
);
await app.close();

latencies.sort((a, b) => a - b);
const durationSeconds = (performance.now() - started) / 1000;
const summary = {
  totalRequests,
  successfulRequests,
  failedRequests,
  requestsPerSecond: Number((totalRequests / durationSeconds).toFixed(2)),
  p50LatencyMs: percentile(latencies, 0.5),
  p95LatencyMs: percentile(latencies, 0.95),
  p99LatencyMs: percentile(latencies, 0.99),
  firstTokenLatencyMs: null,
  fallbackCount: 0,
  errorRate: Number((failedRequests / totalRequests).toFixed(4)),
  note: "Deterministic local smoke only; not a production performance claim."
};
console.log(JSON.stringify(summary, null, 2));

function percentile(values, p) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.floor(values.length * p));
  return Number(values[index].toFixed(2));
}
