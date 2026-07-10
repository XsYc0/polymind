import { describe, expect, it } from "vitest";
import { buildApp } from "@polymind/gateway/app";
import { testConfig } from "@polymind/test-utils";

describe("e2e smoke", () => {
  it("starts on a real port, accepts an OpenAI-compatible request, and records a trace", async () => {
    const { app } = await buildApp(testConfig());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "polymind/auto",
        messages: [{ role: "user", content: "What is PolyMind?" }]
      })
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.polymind.traceId).toBeTruthy();
    const trace = await fetch(
      `http://127.0.0.1:${address.port}/v1/traces/${body.polymind.traceId}`
    );
    expect(trace.status).toBe(200);
    await app.close();
  });
});
