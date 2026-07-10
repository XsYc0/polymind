import type {
  ChatCompletionRequest,
  FailureCategory,
  ModelCapability,
  ModelDefinition,
  ProviderDefinition,
  TokenUsage
} from "@polymind/contracts";
import { PolyMindError } from "@polymind/contracts";

export interface ProviderHealth {
  healthy: boolean;
  latencyMs?: number | undefined;
  reason?: string | undefined;
}

export interface ProviderChatResult {
  content: string;
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  usage?: TokenUsage | undefined;
  raw?: unknown;
}

export interface ProviderChatChunk {
  delta: string;
  done: boolean;
  usage?: TokenUsage | undefined;
}

export interface ProviderChatOptions {
  request: ChatCompletionRequest;
  model: ModelDefinition;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  traceId: string;
}

export interface LlmProvider {
  readonly definition: ProviderDefinition;
  capabilities(): ModelCapability[];
  listModels(signal?: AbortSignal): Promise<ModelDefinition[]>;
  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;
  chat(options: ProviderChatOptions): Promise<ProviderChatResult>;
  streamChat(options: ProviderChatOptions): AsyncIterable<ProviderChatChunk>;
}

export class ProviderManager {
  private readonly providers = new Map<string, LlmProvider>();

  register(provider: LlmProvider): void {
    this.providers.set(provider.definition.id, provider);
  }

  get(providerId: string): LlmProvider {
    const provider = this.providers.get(providerId);
    if (!provider)
      throw new PolyMindError(
        `Provider not registered: ${providerId}`,
        "provider_not_registered",
        500
      );
    return provider;
  }

  all(): LlmProvider[] {
    return [...this.providers.values()];
  }

  async healthMap(): Promise<Map<string, ProviderHealth>> {
    const entries = await Promise.all(
      this.all().map(
        async (provider) => [provider.definition.id, await provider.healthCheck()] as const
      )
    );
    return new Map(entries);
  }
}

export function normalizeProviderError(error: unknown): PolyMindError {
  if (error instanceof PolyMindError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new PolyMindError(
      "Provider request timed out",
      "provider_timeout",
      504,
      "timeout",
      true
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  const category: FailureCategory = /auth|unauthorized|forbidden|api key/i.test(message)
    ? "auth"
    : /timeout|aborted/i.test(message)
      ? "timeout"
      : /rate/i.test(message)
        ? "rate_limit"
        : "unknown";
  return new PolyMindError(
    message,
    "provider_error",
    category === "auth" ? 401 : 502,
    category,
    category !== "auth"
  );
}

export function withTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
  return controller.signal;
}

export function estimateTokensFromText(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
