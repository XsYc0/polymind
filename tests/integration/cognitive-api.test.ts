import { describe, expect, it } from "vitest";
import { buildApp } from "@polymind/gateway/app";
import { testConfig } from "@polymind/test-utils";

describe("cognitive execution API", () => {
  it("executes direct virtual model requests and exposes observability", async () => {
    const { app } = await buildApp(testConfig());
    const execution = await app.inject({
      method: "POST",
      url: "/v1/executions",
      payload: {
        model: "polymind/direct",
        messages: [{ role: "user", content: "Say hello" }],
        polymind: { mode: "direct", explain: true }
      }
    });

    expect(execution.statusCode).toBe(200);
    const body = JSON.parse(execution.body) as { executionId: string; plan: { mode: string } };
    expect(body.plan.mode).toBe("direct");

    const plan = await app.inject({
      method: "GET",
      url: `/v1/executions/${body.executionId}/plan`
    });
    expect(plan.statusCode).toBe(200);
    expect(JSON.parse(plan.body).plan.mode).toBe("direct");

    const traces = await app.inject({ method: "GET", url: "/v1/traces?limit=10" });
    expect(traces.statusCode).toBe(200);

    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    expect(JSON.parse(openapi.body).paths["/v1/executions"]).toBeDefined();
    await app.close();
  });

  it("reports cache, performance, runtime metrics, and Ruflo status", async () => {
    const { app } = await buildApp(testConfig());
    for (const url of [
      "/v1/cache/stats",
      "/v1/performance/leaderboard",
      "/v1/runtime/metrics",
      "/v1/integrations/ruflo/status"
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
    }
    await app.close();
  });
});
