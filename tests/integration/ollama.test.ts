import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { OllamaProvider } from "@polymind/ollama";
import type { ModelDefinition, ProviderDefinition } from "@polymind/contracts";

let server: ReturnType<typeof createServer> | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

describe("ollama adapter", () => {
  it("uses Ollama HTTP API shape with a mock server", async () => {
    server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/tags")
        response.end(JSON.stringify({ models: [{ name: "llama3.2" }] }));
      else if (request.url === "/api/chat") {
        response.end(
          JSON.stringify({
            message: { content: "hello from ollama" },
            prompt_eval_count: 2,
            eval_count: 3
          })
        );
      } else {
        response.statusCode = 404;
        response.end("{}");
      }
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const providerDef: ProviderDefinition = {
      id: "ollama",
      displayName: "Ollama",
      type: "ollama",
      baseUrl: `http://127.0.0.1:${address.port}`,
      enabled: true,
      health: { enabled: true, timeoutMs: 1000 },
      metadata: {}
    };
    const model: ModelDefinition = {
      id: "ollama/llama3.2",
      providerId: "ollama",
      upstreamModel: "llama3.2",
      displayName: "llama3.2",
      enabled: true,
      capabilities: ["chat"],
      relativeQuality: 0.5,
      relativeSpeed: 0.5,
      privacyClass: "local",
      tags: [],
      metadata: {}
    };
    const provider = new OllamaProvider(providerDef, [model]);
    expect((await provider.healthCheck()).healthy).toBe(true);
    const result = await provider.chat({
      request: {
        model: "polymind/auto",
        messages: [{ role: "user", content: "hi" }],
        stream: false
      },
      model,
      timeoutMs: 1000,
      traceId: "t"
    });
    expect(result.content).toBe("hello from ollama");
    expect(result.usage?.totalTokens).toBe(5);
  });
});
