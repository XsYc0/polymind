import type {
  ChatMessage,
  ModelCapability,
  ModelDefinition,
  ProviderDefinition,
  TokenUsage
} from "@polymind/contracts";
import { PolyMindError } from "@polymind/contracts";
import type {
  LlmProvider,
  ProviderChatChunk,
  ProviderChatOptions,
  ProviderChatResult,
  ProviderHealth
} from "@polymind/provider-sdk";
import { normalizeProviderError } from "@polymind/provider-sdk";
import {
  apiKeyHeader,
  bearer,
  compactHeaders,
  joinUrl,
  jsonRequest,
  normalizeFinishReason,
  parseSse,
  rawRequest
} from "./transport.js";

type SecretResolver = (secretRef?: string) => string | undefined;

interface ProviderDeps {
  resolveSecret: SecretResolver;
  fetchImpl?: typeof fetch;
}

class OpenAIStyleProvider implements LlmProvider {
  constructor(
    private readonly providerName: string,
    readonly definition: ProviderDefinition,
    private readonly models: ModelDefinition[],
    private readonly deps: ProviderDeps,
    private readonly options: {
      defaultBaseUrl: string;
      authHeader: (token?: string) => string | undefined;
      extraHeaders?: () => Record<string, string>;
      capabilities: ModelCapability[];
    }
  ) {}

  capabilities(): ModelCapability[] {
    return this.options.capabilities;
  }

  async listModels(signal?: AbortSignal): Promise<ModelDefinition[]> {
    try {
      await jsonRequest<{ data?: unknown[] }>({
        url: joinUrl(this.baseUrl(), "models"),
        headers: this.headers(),
        timeoutMs: this.definition.health.timeoutMs,
        signal,
        fetchImpl: this.deps.fetchImpl,
        providerName: this.providerName
      });
    } catch {
      return this.models;
    }
    return this.models;
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.listModels(signal);
      return { healthy: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { healthy: false, latencyMs: Date.now() - started, reason: String(error) };
    }
  }

  async chat(options: ProviderChatOptions): Promise<ProviderChatResult> {
    try {
      const response = await jsonRequest<OpenAIResponse>({
        url: joinUrl(this.baseUrl(), "chat/completions"),
        method: "POST",
        headers: this.headers(),
        body: this.requestBody(options, false),
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        fetchImpl: this.deps.fetchImpl,
        providerName: this.providerName
      });
      return openAIResponseToResult(response.data);
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async *streamChat(options: ProviderChatOptions): AsyncIterable<ProviderChatChunk> {
    try {
      const response = await rawRequest({
        url: joinUrl(this.baseUrl(), "chat/completions"),
        method: "POST",
        headers: { ...this.headers(), accept: "text/event-stream" },
        body: this.requestBody(options, true),
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        fetchImpl: this.deps.fetchImpl,
        providerName: this.providerName
      });
      if (!response.body) throw new Error(`${this.providerName} stream response had no body`);
      for await (const data of parseSse(response.body)) {
        if (data === "[DONE]") break;
        const chunk = JSON.parse(data) as OpenAIChunk;
        yield openAIChunkToProviderChunk(chunk);
      }
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  private baseUrl(): string {
    return this.definition.baseUrl ?? this.options.defaultBaseUrl;
  }

  private headers(): Record<string, string> {
    const token = this.deps.resolveSecret(this.definition.secretRef);
    return compactHeaders({
      authorization: this.options.authHeader(token),
      ...this.options.extraHeaders?.()
    });
  }

  private requestBody(options: ProviderChatOptions, stream: boolean): Record<string, unknown> {
    return {
      model: options.model.upstreamModel,
      messages: options.request.messages,
      temperature: options.request.temperature,
      max_tokens: options.request.max_tokens ?? options.request.max_completion_tokens,
      stream,
      stream_options: stream ? { include_usage: true } : undefined,
      tools: options.request.tools,
      response_format: options.request.response_format
    };
  }
}

export class OpenAIProvider extends OpenAIStyleProvider {
  constructor(definition: ProviderDefinition, models: ModelDefinition[], deps: ProviderDeps) {
    super("OpenAI", definition, models, deps, {
      defaultBaseUrl: "https://api.openai.com/v1/",
      authHeader: (token) => bearer(token),
      extraHeaders: () =>
        compactHeaders({
          "openai-organization": stringMeta(definition, "organization"),
          "openai-project": stringMeta(definition, "project"),
          ...recordMeta(definition, "headers")
        }),
      capabilities: [
        "chat",
        "streaming",
        "tool-use",
        "structured-output",
        "token-usage",
        "model-listing"
      ]
    });
  }
}

export class DeepSeekProvider extends OpenAIStyleProvider {
  constructor(definition: ProviderDefinition, models: ModelDefinition[], deps: ProviderDeps) {
    super("DeepSeek", definition, models, deps, {
      defaultBaseUrl: "https://api.deepseek.com/v1/",
      authHeader: (token) => bearer(token),
      capabilities: ["chat", "streaming", "reasoning", "token-usage", "model-listing"]
    });
  }
}

export class AnthropicProvider implements LlmProvider {
  constructor(
    readonly definition: ProviderDefinition,
    private readonly models: ModelDefinition[],
    private readonly deps: ProviderDeps
  ) {}

  capabilities(): ModelCapability[] {
    return ["chat", "streaming", "tool-use", "token-usage"];
  }

  async listModels(signal?: AbortSignal): Promise<ModelDefinition[]> {
    void signal;
    return this.models;
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.listModels(signal);
      return { healthy: true, latencyMs: Date.now() - started };
    } catch (error) {
      return { healthy: false, latencyMs: Date.now() - started, reason: String(error) };
    }
  }

  async chat(options: ProviderChatOptions): Promise<ProviderChatResult> {
    try {
      const response = await jsonRequest<AnthropicResponse>({
        url: joinUrl(this.baseUrl(), "messages"),
        method: "POST",
        headers: this.headers(),
        body: this.requestBody(options, false),
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        fetchImpl: this.deps.fetchImpl,
        providerName: "Anthropic"
      });
      return anthropicResponseToResult(response.data);
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async *streamChat(options: ProviderChatOptions): AsyncIterable<ProviderChatChunk> {
    try {
      const response = await rawRequest({
        url: joinUrl(this.baseUrl(), "messages"),
        method: "POST",
        headers: { ...this.headers(), accept: "text/event-stream" },
        body: this.requestBody(options, true),
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        fetchImpl: this.deps.fetchImpl,
        providerName: "Anthropic"
      });
      if (!response.body) throw new Error("Anthropic stream response had no body");
      let pendingToolId: string | undefined;
      let pendingToolName: string | undefined;
      for await (const data of parseSse(response.body)) {
        const event = JSON.parse(data) as AnthropicEvent;
        if (event.type === "message_start") yield { role: "assistant" };
        if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          pendingToolId = event.content_block.id;
          pendingToolName = event.content_block.name;
          yield {
            toolCallDelta: [
              {
                index: event.index ?? 0,
                id: pendingToolId,
                type: "function",
                function: { name: pendingToolName, arguments: "" }
              }
            ]
          };
        }
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          yield { delta: event.delta.text };
        }
        if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          yield {
            toolCallDelta: [
              {
                index: event.index ?? 0,
                id: pendingToolId,
                type: "function",
                function: { name: pendingToolName, arguments: event.delta.partial_json ?? "" }
              }
            ]
          };
        }
        if (event.type === "message_delta") {
          yield {
            finishReason: normalizeFinishReason(event.delta?.stop_reason),
            usage: normalizeAnthropicUsage(event.usage)
          };
        }
      }
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  private baseUrl(): string {
    return this.definition.baseUrl ?? "https://api.anthropic.com/v1/";
  }

  private headers(): Record<string, string> {
    return compactHeaders({
      "x-api-key": apiKeyHeader(this.deps.resolveSecret(this.definition.secretRef)),
      "anthropic-version": stringMeta(this.definition, "apiVersion") ?? "2023-06-01"
    });
  }

  private requestBody(options: ProviderChatOptions, stream: boolean): Record<string, unknown> {
    const system = options.request.messages
      .filter((message) => message.role === "system")
      .map((message) => stringifyContent(message.content))
      .join("\n\n");
    const messages = options.request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: stringifyContent(message.content)
      }));
    return {
      model: options.model.upstreamModel,
      max_tokens: options.request.max_tokens ?? options.request.max_completion_tokens ?? 1024,
      temperature: options.request.temperature,
      system: system || undefined,
      messages,
      stream,
      tools: options.request.tools
    };
  }
}

export class GeminiProvider implements LlmProvider {
  constructor(
    readonly definition: ProviderDefinition,
    private readonly models: ModelDefinition[],
    private readonly deps: ProviderDeps
  ) {}

  capabilities(): ModelCapability[] {
    return ["chat", "streaming", "tool-use", "structured-output", "token-usage"];
  }

  async listModels(signal?: AbortSignal): Promise<ModelDefinition[]> {
    void signal;
    return this.models;
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    void signal;
    return { healthy: true, latencyMs: 1 };
  }

  async chat(options: ProviderChatOptions): Promise<ProviderChatResult> {
    try {
      const response = await jsonRequest<GeminiResponse>({
        url: this.url(options.model.upstreamModel, "generateContent"),
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey() ?? "" },
        body: this.requestBody(options),
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        fetchImpl: this.deps.fetchImpl,
        providerName: "Gemini"
      });
      return geminiResponseToResult(response.data);
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  async *streamChat(options: ProviderChatOptions): AsyncIterable<ProviderChatChunk> {
    try {
      const response = await rawRequest({
        url: this.url(options.model.upstreamModel, "streamGenerateContent?alt=sse"),
        method: "POST",
        headers: { "x-goog-api-key": this.apiKey() ?? "", accept: "text/event-stream" },
        body: this.requestBody(options),
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        fetchImpl: this.deps.fetchImpl,
        providerName: "Gemini"
      });
      if (!response.body) throw new Error("Gemini stream response had no body");
      for await (const data of parseSse(response.body)) {
        const chunk = JSON.parse(data) as GeminiResponse;
        yield geminiResponseToChunk(chunk);
      }
    } catch (error) {
      throw normalizeProviderError(error);
    }
  }

  private url(model: string, action: string): URL {
    return joinUrl(
      this.definition.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta/",
      `models/${model}:${action}`
    );
  }

  private apiKey(): string | undefined {
    return this.deps.resolveSecret(this.definition.secretRef);
  }

  private requestBody(options: ProviderChatOptions): Record<string, unknown> {
    const systemText = options.request.messages
      .filter((message) => message.role === "system")
      .map((message) => stringifyContent(message.content))
      .join("\n\n");
    return {
      systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
      contents: options.request.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role === "assistant" ? "model" : "user",
          parts: [{ text: stringifyContent(message.content) }]
        })),
      tools: options.request.tools,
      generationConfig: {
        temperature: options.request.temperature,
        maxOutputTokens: options.request.max_tokens ?? options.request.max_completion_tokens,
        responseMimeType: isJsonResponseFormat(options.request.response_format)
          ? "application/json"
          : undefined
      }
    };
  }
}

interface OpenAIResponse {
  choices?: Array<{
    message?: { content?: string; tool_calls?: unknown[]; reasoning_content?: string };
    finish_reason?: unknown;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface OpenAIChunk {
  id?: string;
  created?: number;
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: unknown[];
    };
    finish_reason?: unknown;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface AnthropicEvent {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: unknown };
  usage?: { input_tokens?: number; output_tokens?: number };
}

interface GeminiResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; functionCall?: unknown }> };
    finishReason?: unknown;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function openAIResponseToResult(data: OpenAIResponse): ProviderChatResult {
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    finishReason: normalizeFinishReason(choice?.finish_reason),
    usage: openAIUsage(data.usage),
    raw: {
      toolCalls: choice?.message?.tool_calls,
      reasoningContent: choice?.message?.reasoning_content
    }
  };
}

function openAIChunkToProviderChunk(data: OpenAIChunk): ProviderChatChunk {
  const choice = data.choices?.[0];
  return {
    role: choice?.delta?.role === "assistant" ? "assistant" : undefined,
    delta: choice?.delta?.content,
    reasoningDelta: choice?.delta?.reasoning_content,
    toolCallDelta: choice?.delta?.tool_calls,
    finishReason: normalizeFinishReason(choice?.finish_reason),
    usage: openAIUsage(data.usage),
    metadata: { upstreamId: data.id },
    createdAt: data.created ? new Date(data.created * 1000).toISOString() : undefined
  };
}

function anthropicResponseToResult(data: AnthropicResponse): ProviderChatResult {
  const text =
    data.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("") ?? "";
  const toolCalls = data.content?.filter((block) => block.type === "tool_use");
  return {
    content: text,
    finishReason: normalizeFinishReason(data.stop_reason),
    usage: normalizeAnthropicUsage(data.usage),
    raw: { toolCalls }
  };
}

function geminiResponseToResult(data: GeminiResponse): ProviderChatResult {
  if (data.promptFeedback?.blockReason) {
    throw new PolyMindError(
      `Gemini response blocked: ${data.promptFeedback.blockReason}`,
      "gemini_safety_block",
      400,
      "validation",
      false
    );
  }
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  return {
    content: parts.map((part) => part.text ?? "").join(""),
    finishReason: normalizeFinishReason(candidate?.finishReason),
    usage: normalizeGeminiUsage(data.usageMetadata),
    raw: { functionCalls: parts.map((part) => part.functionCall).filter(Boolean) }
  };
}

function geminiResponseToChunk(data: GeminiResponse): ProviderChatChunk {
  if (data.promptFeedback?.blockReason) {
    throw new PolyMindError(
      `Gemini response blocked: ${data.promptFeedback.blockReason}`,
      "gemini_safety_block",
      400,
      "validation",
      false
    );
  }
  const candidate = data.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  return {
    delta: parts.map((part) => part.text ?? "").join("") || undefined,
    toolCallDelta: parts.map((part) => part.functionCall).filter(Boolean),
    finishReason: normalizeFinishReason(candidate?.finishReason),
    usage: normalizeGeminiUsage(data.usageMetadata)
  };
}

function openAIUsage(usage: OpenAIResponse["usage"]): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0
  };
}

function normalizeAnthropicUsage(usage: AnthropicResponse["usage"]): TokenUsage | undefined {
  if (!usage) return undefined;
  const promptTokens = usage.input_tokens ?? 0;
  const completionTokens = usage.output_tokens ?? 0;
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

function normalizeGeminiUsage(usage: GeminiResponse["usageMetadata"]): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.promptTokenCount ?? 0,
    completionTokens: usage.candidatesTokenCount ?? 0,
    totalTokens: usage.totalTokenCount ?? 0
  };
}

function stringifyContent(content: ChatMessage["content"]): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

function stringMeta(definition: ProviderDefinition, key: string): string | undefined {
  const value = definition.metadata[key];
  return typeof value === "string" ? value : undefined;
}

function recordMeta(definition: ProviderDefinition, key: string): Record<string, string> {
  const value = definition.metadata[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function isJsonResponseFormat(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && (value as { type?: unknown }).type === "json_object"
  );
}
