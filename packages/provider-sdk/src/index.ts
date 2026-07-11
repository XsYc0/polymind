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

export type ProviderFinishReason = ProviderChatResult["finishReason"];

export interface ProviderChatChunk {
  role?: "assistant" | undefined;
  delta?: string | undefined;
  reasoningDelta?: string | undefined;
  toolCallDelta?: unknown[] | undefined;
  finishReason?: ProviderFinishReason | undefined;
  usage?: TokenUsage | undefined;
  metadata?: Record<string, unknown> | undefined;
  createdAt?: string | undefined;
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

export type ProviderRuntimeState =
  | "configured"
  | "initializing"
  | "ready"
  | "degraded"
  | "unhealthy"
  | "disabled"
  | "misconfigured"
  | "shutting-down";

export type CircuitBreakerState = "closed" | "open" | "half-open";

export interface ProviderRuntimeStatus {
  providerId: string;
  state: ProviderRuntimeState;
  enabled: boolean;
  inFlight: number;
  maxConcurrentRequests: number;
  circuitBreaker: CircuitBreakerState;
  consecutiveFailures: number;
  rollingSuccessRate: number;
  lastSuccessAt?: string | undefined;
  lastFailureAt?: string | undefined;
  lastHealthCheckAt?: string | undefined;
  cooldownUntil?: string | undefined;
  health?: ProviderHealth | undefined;
}

export interface ProviderManagerOptions {
  defaultMaxConcurrentRequests?: number;
  circuitBreakerThreshold?: number;
  cooldownMs?: number;
}

interface ProviderRuntimeEntry {
  provider: LlmProvider;
  status: ProviderRuntimeStatus;
  recentOutcomes: boolean[];
}

export class ProviderManager {
  private readonly providers = new Map<string, ProviderRuntimeEntry>();

  constructor(private readonly options: ProviderManagerOptions = {}) {}

  register(provider: LlmProvider): void {
    const maxConcurrentRequests = metadataNumber(
      provider.definition.metadata.maxConcurrentRequests,
      this.options.defaultMaxConcurrentRequests ?? 8
    );
    this.providers.set(provider.definition.id, {
      provider,
      recentOutcomes: [],
      status: {
        providerId: provider.definition.id,
        state: provider.definition.enabled ? "configured" : "disabled",
        enabled: provider.definition.enabled,
        inFlight: 0,
        maxConcurrentRequests,
        circuitBreaker: "closed",
        consecutiveFailures: 0,
        rollingSuccessRate: 1
      }
    });
  }

  get(providerId: string): LlmProvider {
    const entry = this.providers.get(providerId);
    if (!entry)
      throw new PolyMindError(
        `Provider not registered: ${providerId}`,
        "provider_not_registered",
        500
      );
    if (!entry.status.enabled || entry.status.state === "disabled") {
      throw new PolyMindError(`Provider disabled: ${providerId}`, "provider_disabled", 409);
    }
    if (entry.status.circuitBreaker === "open") {
      throw new PolyMindError(
        `Provider circuit open: ${providerId}`,
        "provider_circuit_open",
        503,
        "provider_unavailable",
        true
      );
    }
    if (entry.status.inFlight >= entry.status.maxConcurrentRequests) {
      throw new PolyMindError(
        `Provider concurrency limit reached: ${providerId}`,
        "provider_concurrency_limited",
        429,
        "rate_limit",
        true
      );
    }
    return entry.provider;
  }

  all(): LlmProvider[] {
    return [...this.providers.values()]
      .filter((entry) => entry.status.enabled && entry.status.circuitBreaker !== "open")
      .map((entry) => entry.provider);
  }

  statuses(): ProviderRuntimeStatus[] {
    return [...this.providers.values()].map((entry) => ({ ...entry.status }));
  }

  status(providerId: string): ProviderRuntimeStatus {
    const entry = this.requireEntry(providerId);
    return { ...entry.status };
  }

  enable(providerId: string): ProviderRuntimeStatus {
    const entry = this.requireEntry(providerId);
    entry.status.enabled = true;
    entry.status.state = "configured";
    entry.status.circuitBreaker = "closed";
    return this.status(providerId);
  }

  disable(providerId: string): ProviderRuntimeStatus {
    const entry = this.requireEntry(providerId);
    entry.status.enabled = false;
    entry.status.state = "disabled";
    return this.status(providerId);
  }

  async withRequest<T>(
    providerId: string,
    work: (provider: LlmProvider) => Promise<T>
  ): Promise<T> {
    const provider = this.get(providerId);
    const entry = this.requireEntry(providerId);
    entry.status.inFlight += 1;
    try {
      const result = await work(provider);
      this.recordSuccess(providerId);
      return result;
    } catch (error) {
      this.recordFailure(providerId);
      throw error;
    } finally {
      entry.status.inFlight = Math.max(0, entry.status.inFlight - 1);
    }
  }

  async healthMap(): Promise<Map<string, ProviderHealth>> {
    const entries = await Promise.all(
      [...this.providers.values()].map(async (entry) => {
        if (!entry.status.enabled)
          return [entry.provider.definition.id, { healthy: false, reason: "disabled" }] as const;
        const health = await entry.provider.healthCheck();
        entry.status.health = health;
        entry.status.lastHealthCheckAt = new Date().toISOString();
        entry.status.state = health.healthy ? "ready" : "degraded";
        return [entry.provider.definition.id, health] as const;
      })
    );
    return new Map(entries);
  }

  async healthCheck(providerId: string): Promise<ProviderHealth> {
    const entry = this.requireEntry(providerId);
    const started = Date.now();
    const health = await entry.provider.healthCheck();
    entry.status.health = { ...health, latencyMs: health.latencyMs ?? Date.now() - started };
    entry.status.lastHealthCheckAt = new Date().toISOString();
    entry.status.state = health.healthy ? "ready" : "unhealthy";
    return entry.status.health;
  }

  private recordSuccess(providerId: string): void {
    const entry = this.requireEntry(providerId);
    entry.status.consecutiveFailures = 0;
    entry.status.lastSuccessAt = new Date().toISOString();
    entry.status.state = "ready";
    entry.status.circuitBreaker = "closed";
    pushOutcome(entry, true);
  }

  private recordFailure(providerId: string): void {
    const entry = this.requireEntry(providerId);
    entry.status.consecutiveFailures += 1;
    entry.status.lastFailureAt = new Date().toISOString();
    pushOutcome(entry, false);
    const threshold = this.options.circuitBreakerThreshold ?? 3;
    if (entry.status.consecutiveFailures >= threshold) {
      entry.status.circuitBreaker = "open";
      entry.status.state = "unhealthy";
      entry.status.cooldownUntil = new Date(
        Date.now() + (this.options.cooldownMs ?? 30_000)
      ).toISOString();
    } else {
      entry.status.state = "degraded";
    }
  }

  private requireEntry(providerId: string): ProviderRuntimeEntry {
    const entry = this.providers.get(providerId);
    if (!entry)
      throw new PolyMindError(
        `Provider not registered: ${providerId}`,
        "provider_not_registered",
        404
      );
    return entry;
  }
}

function pushOutcome(entry: ProviderRuntimeEntry, success: boolean): void {
  entry.recentOutcomes.push(success);
  if (entry.recentOutcomes.length > 20) entry.recentOutcomes.shift();
  const successes = entry.recentOutcomes.filter(Boolean).length;
  entry.status.rollingSuccessRate = successes / entry.recentOutcomes.length;
}

function metadataNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
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
