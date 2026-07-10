import { describe, expect, it } from "vitest";
import { buildApp } from "@polymind/gateway/app";
import { testConfig } from "@polymind/test-utils";

describe("gateway integration", () => {
  it("serves health, models, chat completions, and traces", async () => {
    const { app } = await buildApp(testConfig());
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const models = await app.inject({ method: "GET", url: "/v1/models" });
    expect(models.json().data[0].id).toBe("mock/good");
    const chat = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: { model: "polymind/auto", messages: [{ role: "user", content: "Explain PolyMind" }] }
    });
    expect(chat.statusCode).toBe(200);
    const body = chat.json();
    expect(body.choices[0].message.content).toContain("PolyMind");
    expect(body.polymind.modelId).toBe("mock/good");
    const trace = await app.inject({ method: "GET", url: `/v1/traces/${body.polymind.traceId}` });
    expect(trace.statusCode).toBe(200);
    expect(trace.json().promptHash).toMatch(/^[a-f0-9]{64}$/);
    await app.close();
  });
});
