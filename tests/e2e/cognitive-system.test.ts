import { describe, expect, it } from "vitest";
import { buildApp } from "@polymind/gateway/app";
import { testConfig } from "@polymind/test-utils";

describe("cognitive system E2E", () => {
  it("runs direct specialist council cache and observability paths deterministically", async () => {
    const { app } = await buildApp(testConfig());
    for (const [mode, prompt] of [
      ["direct", "Say hello"],
      ["specialist", "Review this TypeScript auth code for security risk"],
      ["council", "Research competing architectural choices and summarize disagreements"]
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/executions",
        payload: {
          model: `polymind/${mode}`,
          messages: [{ role: "user", content: prompt }],
          polymind: { mode, explain: true }
        }
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.plan.mode).toBe(mode);
      expect(body.explanation.confidence.score).toBeGreaterThan(0);
    }

    expect((await app.inject({ method: "GET", url: "/v1/cache/stats" })).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/performance/leaderboard" })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/integrations/ruflo/status" })).statusCode
    ).toBe(200);
    await app.close();
  });
});
