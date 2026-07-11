import type { ModelCapability, ModelDefinition, ProviderDefinition } from "@polymind/contracts";
import type {
  LlmProvider,
  ProviderChatChunk,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderHealth
} from "@polymind/provider-sdk";
import { normalizeProviderError, withTimeout } from "@polymind/provider-sdk";

export class OllamaProvider implements LlmProvider {
  private readonly baseUrl: string;

  constructor(
    readonly definition: ProviderDefinition,
    private readonly configuredModels: ModelDefinition[],
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = definition.baseUrl ?? "http://127.0.0.1:11434";
  }

  capabilities(): ModelCapability[] {
    return ["chat", "streaming", "coding", "model-listing", "token-usage"];
  }

  async listModels(signal?: AbortSignal): Promise<ModelDefinition[]> {
    try {
      const response = await this.fetchImpl(new URL("/api/tags", this.baseUrl), {
        signal: withTimeout(this.definition.health.timeoutMs, signal)
      });
      if (!response.ok) return this.configuredModels;
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      const known = new Set(this.configuredModels.map((model) => model.upstreamModel));
      const discovered =
        data.models
          ?.filter((model) => !known.has(model.name))
          .map((model) => ({
            id: `ollama/${model.name}`,
            providerId: this.definition.id,
            upstreamModel: model.name,
            displayName: model.name,
            enabled: true,
            capabilities: ["chat"] as ModelCapability[],
            relativeQuality: 0.5,
            relativeSpeed: 0.5,
            privacyClass: "local" as const,
            tags: ["discovered"],
            metadata: {}
          })) ?? [];
      return [...this.configuredModels, ...discovered];
    } catch {
      return this.configuredModels;
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const response = await this.fetchImpl(new URL("/api/tags", this.baseUrl), {
        signal: withTimeout(this.definition.health.timeoutMs, signal)
      });
      return {
        healthy: response.ok,
        latencyMs: Date.now() - started,
        reason: response.ok ? undefined : response.statusText
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: Date.now() - started,
        reason: normalizeProviderError(error).message
      };
    }
  }

  async chat(options: ProviderChatOptions): Promise<ProviderChatResult> {
    try {
      const response = await this.fetchImpl(new URL("/api/chat", this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: withTimeout(options.timeoutMs, options.signal),
        body: JSON.stringify({
          model: options.model.upstreamModel,
          messages: options.request.messages.map((message) => ({
            role: message.role,
            content: message.content
          })),
          stream: false,
          options: {
            temperature: options.request.temperature,
            num_predict: options.request.max_tokens ?? options.request.max_completion_tokens
          }
        })
      });
      if (!response.ok)
        throw new Error(`Ollama request failed ${response.status}: ${await response.text()}`);
      const data = (await response.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const promptTokens = data.prompt_eval_count ?? 0;
      const completionTokens = data.eval_count ?? 0;
      return {
        content: data.message?.content ?? "",
        finishReason: "stop",
        usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        raw: data
      };
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async *streamChat(options: ProviderChatOptions): AsyncIterable<ProviderChatChunk> {
    try {
      const response = await this.fetchImpl(new URL("/api/chat", this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: withTimeout(options.timeoutMs, options.signal),
        body: JSON.stringify({
          model: options.model.upstreamModel,
          messages: options.request.messages.map((message) => ({
            role: message.role,
            content: message.content
          })),
          stream: true,
          options: {
            temperature: options.request.temperature,
            num_predict: options.request.max_tokens ?? options.request.max_completion_tokens
          }
        })
      });
      if (!response.ok)
        throw new Error(`Ollama stream failed ${response.status}: ${await response.text()}`);
      if (!response.body) throw new Error("Ollama stream response had no body");
      yield { role: "assistant", createdAt: new Date().toISOString() };
      for await (const line of parseJsonLines(response.body)) {
        const data = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        if (data.message?.content) {
          yield { delta: data.message.content, createdAt: new Date().toISOString() };
        }
        if (data.done) {
          const promptTokens = data.prompt_eval_count ?? 0;
          const completionTokens = data.eval_count ?? 0;
          yield {
            finishReason: "stop",
            usage: {
              promptTokens,
              completionTokens,
              totalTokens: promptTokens + completionTokens
            },
            createdAt: new Date().toISOString()
          };
        }
      }
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }
}

async function* parseJsonLines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield line;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
