import { describe, expect, it } from "vitest";
import { buildApp } from "@polymind/gateway/app";
import { testConfig } from "@polymind/test-utils";

describe("streaming gateway", () => {
  it("emits OpenAI-compatible SSE chunks and one DONE marker", async () => {
    const { app } = await buildApp(testConfig());
    const response = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "polymind/auto",
        stream: true,
        messages: [{ role: "user", content: "Stream PolyMind" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    const events = response.body
      .trim()
      .split(/\n\n/)
      .map((line) => line.replace(/^data: /, ""));
    expect(events.filter((event) => event === "[DONE]")).toHaveLength(1);
    const chunks = events
      .filter((event) => event !== "[DONE]")
      .map(
        (event) =>
          JSON.parse(event) as {
            object: string;
            choices: Array<{
              delta: { role?: string; content?: string };
              finish_reason: string | null;
            }>;
            usage?: unknown;
          }
      );

    expect(chunks[0]?.object).toBe("chat.completion.chunk");
    expect(chunks[0]?.choices[0]?.delta.role).toBe("assistant");
    expect(chunks.some((chunk) => chunk.choices[0]?.delta.content?.includes("PolyMind"))).toBe(
      true
    );
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    expect(chunks.at(-1)?.usage).toBeDefined();
    await app.close();
  });
});
