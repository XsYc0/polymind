import type {
  ModelCapability,
  ModelDefinition,
  ProviderDefinition,
  TokenUsage
} from "@polymind/contracts";
import type {
  LlmProvider,
  ProviderChatChunk,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderHealth
} from "@polymind/provider-sdk";
import { PolyMindError } from "@polymind/contracts";
import { estimateTokensFromText } from "@polymind/provider-sdk";

export interface MockProviderScenario {
  latencyMs?: number;
  fail?: boolean;
  failBeforeFirstChunk?: boolean;
  failAfterChunks?: number;
  failureCategory?: "auth" | "timeout" | "rate_limit" | "provider_unavailable" | "unknown";
  healthy?: boolean;
  response?: string;
  streamChunks?: string[];
  streamDelayMs?: number;
  emptyStream?: boolean;
  toolCallStream?: boolean;
  usage?: TokenUsage;
  confidence?: number;
  capabilities?: ModelCapability[];
}

export class MockProvider implements LlmProvider {
  constructor(
    readonly definition: ProviderDefinition,
    private readonly models: ModelDefinition[],
    private readonly scenario: MockProviderScenario = {}
  ) {}

  capabilities(): ModelCapability[] {
    return this.scenario.capabilities ?? ["chat", "streaming", "structured-output", "tool-use"];
  }

  async listModels(): Promise<ModelDefinition[]> {
    return this.models;
  }

  async healthCheck(): Promise<ProviderHealth> {
    await sleep(this.scenario.latencyMs ?? 1);
    return {
      healthy: this.scenario.healthy ?? true,
      latencyMs: this.scenario.latencyMs ?? 1,
      reason: this.scenario.healthy === false ? "configured mock unhealthy" : undefined
    };
  }

  async chat(options: ProviderChatOptions): Promise<ProviderChatResult> {
    await sleep(this.scenario.latencyMs ?? 1, options.signal);
    if (this.scenario.fail) {
      const category = this.scenario.failureCategory ?? "provider_unavailable";
      throw new PolyMindError(
        `Mock provider configured failure: ${category}`,
        "mock_failure",
        category === "auth" ? 401 : 502,
        category,
        category !== "auth"
      );
    }
    const userText = options.request.messages
      .filter((message) => message.role === "user")
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content)
      )
      .join("\n");
    const content =
      this.scenario.response ??
      `PolyMind routed this request to ${options.model.id}. It provides one adaptive OpenAI-compatible endpoint across configured models.`;
    const promptTokens = estimateTokensFromText(userText);
    const completionTokens = estimateTokensFromText(content);
    return {
      content,
      finishReason: "stop",
      usage: this.scenario.usage ?? {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens
      },
      raw: { confidence: this.scenario.confidence ?? 0.9 }
    };
  }

  async *streamChat(options: ProviderChatOptions): AsyncIterable<ProviderChatChunk> {
    if (this.scenario.failBeforeFirstChunk) {
      throw failure(this.scenario.failureCategory);
    }
    const result = await this.chat({ ...options, request: { ...options.request, stream: false } });
    yield { role: "assistant", createdAt: new Date().toISOString() };
    if (this.scenario.toolCallStream) {
      yield {
        toolCallDelta: [
          {
            index: 0,
            id: "call_mock",
            type: "function",
            function: { name: "mock_tool", arguments: '{"value"' }
          }
        ],
        createdAt: new Date().toISOString()
      };
      yield {
        toolCallDelta: [{ index: 0, function: { arguments: ":true}" } }],
        createdAt: new Date().toISOString()
      };
    } else if (!this.scenario.emptyStream) {
      const chunks = this.scenario.streamChunks ?? splitIntoChunks(result.content);
      for (const [index, chunk] of chunks.entries()) {
        await sleep(this.scenario.streamDelayMs ?? 0, options.signal);
        if (this.scenario.failAfterChunks === index) throw failure(this.scenario.failureCategory);
        yield { delta: chunk, createdAt: new Date().toISOString() };
      }
    }
    yield {
      finishReason: result.finishReason,
      usage: result.usage,
      createdAt: new Date().toISOString()
    };
  }
}

function failure(category: MockProviderScenario["failureCategory"]): PolyMindError {
  const resolved = category ?? "provider_unavailable";
  return new PolyMindError(
    `Mock provider configured failure: ${resolved}`,
    "mock_failure",
    resolved === "auth" ? 401 : 502,
    resolved,
    resolved !== "auth"
  );
}

function splitIntoChunks(value: string): string[] {
  if (value.length === 0) return [];
  const words = value.split(/(\s+)/).filter((part) => part.length > 0);
  return words.length > 0 ? words : [value];
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}
