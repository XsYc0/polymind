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
  failureCategory?: "auth" | "timeout" | "rate_limit" | "provider_unavailable" | "unknown";
  healthy?: boolean;
  response?: string;
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
    return this.scenario.capabilities ?? ["chat", "structured-output", "tool-use"];
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
    const result = await this.chat(options);
    yield { delta: result.content, done: false };
    yield { delta: "", done: true, usage: result.usage };
  }
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
