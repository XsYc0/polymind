import type { ModelCapability, ModelDefinition, ProviderDefinition } from "@polymind/contracts";
import type {
  LlmProvider,
  ProviderChatChunk,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderHealth
} from "@polymind/provider-sdk";
import { normalizeProviderError, withTimeout } from "@polymind/provider-sdk";

export class OpenAICompatibleProvider implements LlmProvider {
  constructor(
    readonly definition: ProviderDefinition,
    private readonly models: ModelDefinition[],
    private readonly resolveSecret: (secretRef?: string) => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  capabilities(): ModelCapability[] {
    return ["chat", "tool-use", "structured-output"];
  }

  async listModels(signal?: AbortSignal): Promise<ModelDefinition[]> {
    const baseUrl = this.requireBaseUrl();
    const token = this.resolveSecret(this.definition.secretRef);
    try {
      const response = await this.fetchImpl(new URL("models", ensureSlash(baseUrl)), {
        ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        signal: withTimeout(this.definition.health.timeoutMs, signal)
      });
      if (!response.ok) return this.models;
      return this.models;
    } catch {
      return this.models;
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.listModels(signal);
      return { healthy: true, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - started,
        reason: normalizeProviderError(error).message
      };
    }
  }

  async chat(options: ProviderChatOptions): Promise<ProviderChatResult> {
    const baseUrl = this.requireBaseUrl();
    const token = this.resolveSecret(this.definition.secretRef);
    try {
      const response = await this.fetchImpl(new URL("chat/completions", ensureSlash(baseUrl)), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        signal: withTimeout(options.timeoutMs, options.signal),
        body: JSON.stringify({
          model: options.model.upstreamModel,
          messages: options.request.messages,
          temperature: options.request.temperature,
          max_tokens: options.request.max_tokens ?? options.request.max_completion_tokens,
          stream: false,
          tools: options.request.tools,
          response_format: options.request.response_format
        })
      });
      if (!response.ok)
        throw new Error(
          `OpenAI-compatible request failed ${response.status}: ${await response.text()}`
        );
      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: ProviderChatResult["finishReason"];
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      const usage = data.usage
        ? {
            promptTokens: data.usage.prompt_tokens ?? 0,
            completionTokens: data.usage.completion_tokens ?? 0,
            totalTokens: data.usage.total_tokens ?? 0
          }
        : undefined;
      return {
        content: data.choices?.[0]?.message?.content ?? "",
        finishReason: data.choices?.[0]?.finish_reason ?? "stop",
        usage,
        raw: data
      };
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async *streamChat(options: ProviderChatOptions): AsyncIterable<ProviderChatChunk> {
    const result = await this.chat(options);
    yield { delta: result.content, done: false };
    yield { delta: "", done: true, usage: result.usage };
  }

  private requireBaseUrl(): string {
    if (!this.definition.baseUrl)
      throw new Error(`Provider ${this.definition.id} requires baseUrl`);
    return this.definition.baseUrl;
  }
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
