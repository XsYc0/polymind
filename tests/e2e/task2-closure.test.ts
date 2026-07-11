import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "@polymind/gateway/app";
import { testConfig } from "@polymind/test-utils";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Task 2 closure E2E", () => {
  it("covers provider lifecycle streaming traces health performance restart and shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polymind-task2-"));
    dirs.push(dir);
    const config = testConfig({
      storage: { sqlitePath: join(dir, "polymind.db"), storeRequestContent: false }
    });
    const { app } = await buildApp(config);

    const create = await app.inject({
      method: "POST",
      url: "/v1/providers",
      remoteAddress: "127.0.0.1",
      payload: {
        provider: {
          id: "mock-secondary",
          displayName: "Mock Secondary",
          type: "mock",
          enabled: true,
          health: { enabled: true, timeoutMs: 1000 },
          metadata: {}
        },
        models: [
          {
            id: "mock/secondary",
            providerId: "mock-secondary",
            upstreamModel: "mock-secondary",
            displayName: "Mock Secondary",
            enabled: true,
            capabilities: ["chat", "streaming"],
            relativeQuality: 0.6,
            relativeSpeed: 0.8,
            privacyClass: "public",
            tags: [],
            metadata: {}
          }
        ]
      }
    });
    expect(create.statusCode).toBe(201);

    const completion = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "polymind/auto",
        messages: [{ role: "user", content: "Task two completion smoke" }]
      }
    });
    expect(completion.statusCode).toBe(200);
    const completionBody = JSON.parse(completion.body);
    expect(completionBody.polymind.traceId).toBeTruthy();
    expect(completionBody.usage.total_tokens).toBeGreaterThan(0);

    const stream = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "polymind/auto",
        stream: true,
        messages: [{ role: "user", content: "Task two stream smoke" }]
      }
    });
    const events = stream.body
      .trim()
      .split(/\n\n/)
      .map((line) => line.replace(/^data: /, ""));
    expect(events.filter((event) => event === "[DONE]")).toHaveLength(1);
    const chunks = events.filter((event) => event !== "[DONE]").map((event) => JSON.parse(event));
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    expect(chunks.some((chunk) => chunk.choices[0].delta.content)).toBe(true);
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");

    const trace = await app.inject({
      method: "GET",
      url: `/v1/traces/${completionBody.polymind.traceId}`
    });
    expect(trace.statusCode).toBe(200);
    const attempts = await app.inject({
      method: "GET",
      url: `/v1/traces/${completionBody.polymind.traceId}/attempts`
    });
    expect(JSON.parse(attempts.body).data.length).toBeGreaterThan(0);

    const health = await app.inject({
      method: "POST",
      url: "/v1/providers/mock-secondary/health/check",
      remoteAddress: "127.0.0.1"
    });
    expect(health.statusCode).toBe(200);
    const healthHistory = await app.inject({
      method: "GET",
      url: "/v1/providers/mock-secondary/health/history"
    });
    expect(JSON.parse(healthHistory.body).data.length).toBeGreaterThan(0);

    const modelPerformance = await app.inject({
      method: "GET",
      url: "/v1/performance/leaderboard"
    });
    expect(modelPerformance.statusCode).toBe(200);

    const disable = await app.inject({
      method: "POST",
      url: "/v1/providers/mock-secondary/disable",
      remoteAddress: "127.0.0.1"
    });
    expect(JSON.parse(disable.body).state).toBe("disabled");
    const enable = await app.inject({
      method: "POST",
      url: "/v1/providers/mock-secondary/enable",
      remoteAddress: "127.0.0.1"
    });
    expect(JSON.parse(enable.body).enabled).toBe(true);

    expect((await app.inject({ method: "GET", url: "/v1/runtime/status" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/openapi.json" })).statusCode).toBe(200);
    await app.close();

    const restarted = await buildApp(config);
    const persisted = await restarted.app.inject({
      method: "GET",
      url: "/v1/providers/mock-secondary"
    });
    expect(persisted.statusCode).toBe(200);
    await restarted.app.close();
  });
});
