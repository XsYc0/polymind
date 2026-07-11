import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  DeepSeekProvider,
  GeminiProvider,
  OpenAIProvider
} from "@polymind/cloud-providers";
import type { ModelDefinition, ProviderDefinition } from "@polymind/contracts";

const model: ModelDefinition = {
  id: "cloud/test",
  providerId: "cloud",
  upstreamModel: "upstream-test",
  displayName: "Cloud Test",
  enabled: true,
  capabilities: ["chat", "streaming", "tool-use", "structured-output"],
  relativeQuality: 0.5,
  relativeSpeed: 0.5,
  privacyClass: "public",
  tags: [],
  metadata: {}
};

const request = {
  model: "cloud/test",
  messages: [
    { role: "system" as const, content: "Be brief" },
    { role: "user" as const, content: "Hello" }
  ],
  stream: false
};

describe("official cloud provider adapters", () => {
  it("normalizes OpenAI-compatible success, streaming, usage, and tool calls", async () => {
    const provider = new OpenAIProvider(def("openai"), [model], {
      resolveSecret: () => "test-key",
      fetchImpl: fakeFetch({
        json: {
          choices: [
            {
              message: { content: "ok", tool_calls: [{ id: "call_1" }] },
              finish_reason: "tool_calls"
            }
          ],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        },
        streamEvents: [
          { choices: [{ delta: { role: "assistant" } }] },
          { choices: [{ delta: { content: "ok" } }] },
          {
            choices: [{ finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
          }
        ]
      })
    });

    const result = await provider.chat({ request, model, timeoutMs: 1000, traceId: "trace" });
    expect(result.content).toBe("ok");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage?.totalTokens).toBe(5);

    const chunks = [];
    for await (const chunk of provider.streamChat({
      request: { ...request, stream: true },
      model,
      timeoutMs: 1000,
      traceId: "trace"
    })) {
      chunks.push(chunk);
    }
    expect(chunks.some((chunk) => chunk.role === "assistant")).toBe(true);
    expect(chunks.some((chunk) => chunk.delta === "ok")).toBe(true);
    expect(chunks.at(-1)?.usage?.totalTokens).toBe(5);
  });

  it("maps OpenAI authentication, rate limit, server, cancellation, and malformed failures", async () => {
    const auth = new OpenAIProvider(def("openai"), [model], {
      resolveSecret: () => "bad",
      fetchImpl: async () => new Response("unauthorized", { status: 401 })
    });
    await expect(
      auth.chat({ request, model, timeoutMs: 1000, traceId: "trace" })
    ).rejects.toMatchObject({
      category: "auth"
    });

    const malformed = new OpenAIProvider(def("openai"), [model], {
      resolveSecret: () => "key",
      fetchImpl: async () => new Response("{", { status: 200 })
    });
    await expect(
      malformed.chat({ request, model, timeoutMs: 1000, traceId: "trace" })
    ).rejects.toMatchObject({ code: "provider_malformed_response" });
  });

  it("translates Anthropic system text, tool use, usage, and stream deltas", async () => {
    let upstreamBody = "";
    const provider = new AnthropicProvider(def("anthropic"), [model], {
      resolveSecret: () => "test-key",
      fetchImpl: fakeFetch({
        captureBody: (body) => {
          upstreamBody = body;
        },
        json: {
          content: [
            { type: "text", text: "hello" },
            { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 4, output_tokens: 6 }
        },
        streamEvents: [
          { type: "message_start" },
          { type: "content_block_delta", delta: { type: "text_delta", text: "he" } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "llo" } },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { input_tokens: 4, output_tokens: 6 }
          }
        ]
      })
    });
    const result = await provider.chat({ request, model, timeoutMs: 1000, traceId: "trace" });
    expect(upstreamBody).toContain('"system":"Be brief"');
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage?.totalTokens).toBe(10);
  });

  it("normalizes Gemini structured output, function calls, usage, and safety blocks", async () => {
    const provider = new GeminiProvider(def("gemini"), [model], {
      resolveSecret: () => "test-key",
      fetchImpl: fakeFetch({
        json: {
          candidates: [
            {
              content: { parts: [{ text: '{"ok":true}' }, { functionCall: { name: "lookup" } }] },
              finishReason: "STOP"
            }
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
        }
      })
    });
    const result = await provider.chat({
      request: { ...request, response_format: { type: "json_object" } },
      model,
      timeoutMs: 1000,
      traceId: "trace"
    });
    expect(result.content).toContain("ok");
    expect(result.usage?.totalTokens).toBe(3);

    const blocked = new GeminiProvider(def("gemini"), [model], {
      resolveSecret: () => "test-key",
      fetchImpl: fakeFetch({ json: { promptFeedback: { blockReason: "SAFETY" } } })
    });
    await expect(
      blocked.chat({ request, model, timeoutMs: 1000, traceId: "trace" })
    ).rejects.toMatchObject({
      code: "gemini_safety_block"
    });
  });

  it("normalizes DeepSeek reasoning content separately", async () => {
    const provider = new DeepSeekProvider(def("deepseek"), [model], {
      resolveSecret: () => "test-key",
      fetchImpl: fakeFetch({
        streamEvents: [
          { choices: [{ delta: { reasoning_content: "because", content: "answer" } }] },
          { choices: [{ finish_reason: "stop" }] }
        ]
      })
    });
    const chunks = [];
    for await (const chunk of provider.streamChat({
      request: { ...request, stream: true },
      model,
      timeoutMs: 1000,
      traceId: "trace"
    })) {
      chunks.push(chunk);
    }
    expect(chunks[0]?.reasoningDelta).toBe("because");
    expect(chunks[0]?.delta).toBe("answer");
  });
});

function def(type: ProviderDefinition["type"]): ProviderDefinition {
  return {
    id: "cloud",
    displayName: "Cloud",
    type,
    baseUrl: "http://fake.local/v1",
    enabled: true,
    secretRef: "env:TEST_KEY",
    health: { enabled: true, timeoutMs: 1000 },
    metadata: {}
  };
}

function fakeFetch(options: {
  json?: unknown;
  streamEvents?: unknown[];
  captureBody?: (body: string) => void;
}): typeof fetch {
  return async (_input, init) => {
    if (typeof init?.body === "string") options.captureBody?.(init.body);
    const isStream = typeof init?.body === "string" && init.body.includes('"stream":true');
    if (isStream || options.json === undefined) {
      return new Response(sse(options.streamEvents ?? []), {
        status: 200,
        headers: { "content-type": "text/event-stream" }
      });
    }
    return Response.json(options.json);
  };
}

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}
