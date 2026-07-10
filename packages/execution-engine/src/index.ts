import { randomUUID } from "node:crypto";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  RoutingPolicy,
  TokenUsage
} from "@polymind/contracts";
import { PolyMindError } from "@polymind/contracts";
import { estimateConfiguredCost, ModelRegistry } from "@polymind/model-registry";
import type { TraceRecord, PolyMindRepository } from "@polymind/persistence";
import { safePromptHash } from "@polymind/persistence";
import type { ProviderManager } from "@polymind/provider-sdk";
import { normalizeProviderError } from "@polymind/provider-sdk";
import type { RoutingEngine } from "@polymind/router";
import type { TelemetrySink } from "@polymind/telemetry";
import { event } from "@polymind/telemetry";

export interface ExecutionContext {
  requestId?: string;
  traceId?: string;
  timeoutMs: number;
  storeRequestContent: boolean;
  signal?: AbortSignal;
}

export class ExecutionEngine {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly router: RoutingEngine,
    private readonly providers: ProviderManager,
    private readonly repository: PolyMindRepository,
    private readonly telemetry?: TelemetrySink
  ) {}

  async execute(
    request: ChatCompletionRequest,
    policy: RoutingPolicy,
    context: ExecutionContext
  ): Promise<ChatCompletionResponse> {
    if (request.stream)
      throw new PolyMindError(
        "Streaming is not implemented in Task 1 gateway",
        "streaming_unsupported",
        400
      );
    const traceId = context.traceId ?? randomUUID();
    const requestId = context.requestId ?? randomUUID();
    const started = Date.now();
    this.telemetry?.emit(
      event("request.received", { traceId, requestId, strategy: policy.strategy })
    );
    const health = await this.providers.healthMap();
    const decision = this.router.route({
      request,
      policy,
      registry: this.registry,
      health,
      traceId,
      requestId
    });
    const maxAttempts = Math.min(
      policy.maxAttempts ?? 3,
      policy.fallback ? decision.candidates.length : 1
    );
    const attempts: TraceRecord["attempts"] = [];
    let lastError: PolyMindError | undefined;
    for (const candidate of decision.candidates.slice(0, maxAttempts)) {
      const provider = this.providers.get(candidate.model.providerId);
      const attemptStarted = Date.now();
      this.telemetry?.emit(
        event("provider.attempt_started", {
          traceId,
          requestId,
          providerId: provider.definition.id,
          modelId: candidate.model.id,
          strategy: policy.strategy,
          retryCount: attempts.length
        })
      );
      try {
        const result = await provider.chat({
          request,
          model: candidate.model,
          timeoutMs: context.timeoutMs,
          signal: context.signal,
          traceId
        });
        const latencyMs = Date.now() - attemptStarted;
        attempts.push({
          providerId: provider.definition.id,
          modelId: candidate.model.id,
          startedAt: new Date(attemptStarted).toISOString(),
          latencyMs,
          success: true
        });
        this.telemetry?.emit(
          event("provider.attempt_succeeded", {
            traceId,
            requestId,
            providerId: provider.definition.id,
            modelId: candidate.model.id,
            latencyMs,
            usage: result.usage
          })
        );
        const totalLatency = Date.now() - started;
        const estimatedCost = estimateCost(candidate.model.id, this.registry, result.usage);
        const response: ChatCompletionResponse = {
          id: `chatcmpl-${traceId}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: result.content },
              finish_reason: result.finishReason
            }
          ],
          usage: result.usage
            ? {
                prompt_tokens: result.usage.promptTokens,
                completion_tokens: result.usage.completionTokens,
                total_tokens: result.usage.totalTokens
              }
            : undefined,
          polymind: {
            traceId,
            requestId,
            selectedVirtualModel: request.model,
            providerId: provider.definition.id,
            modelId: candidate.model.id,
            upstreamModel: candidate.model.upstreamModel,
            strategy: decision.strategy,
            routingReason: decision.reason,
            estimatedCost,
            latencyMs: totalLatency,
            attempts: attempts.length
          }
        };
        await this.repository.saveTrace({
          traceId,
          requestId,
          createdAt: new Date(started).toISOString(),
          model: request.model,
          promptHash: safePromptHash(request),
          contentStored: context.storeRequestContent,
          requestContent: context.storeRequestContent ? request.messages : undefined,
          responseContent: context.storeRequestContent
            ? response.choices[0]?.message.content
            : undefined,
          selectedProviderId: provider.definition.id,
          selectedModelId: candidate.model.id,
          strategy: decision.strategy,
          routingReason: decision.reason,
          usage: result.usage,
          estimatedCost,
          latencyMs: totalLatency,
          attempts,
          routingDecision: decision
        });
        this.telemetry?.emit(
          event("request.completed", {
            traceId,
            requestId,
            providerId: provider.definition.id,
            modelId: candidate.model.id,
            strategy: decision.strategy,
            latencyMs: totalLatency,
            usage: result.usage,
            estimatedCost
          })
        );
        return response;
      } catch (error) {
        const normalized = normalizeProviderError(error);
        lastError = normalized;
        attempts.push({
          providerId: provider.definition.id,
          modelId: candidate.model.id,
          startedAt: new Date(attemptStarted).toISOString(),
          latencyMs: Date.now() - attemptStarted,
          success: false,
          failureCategory: normalized.category,
          errorMessage: normalized.message
        });
        this.telemetry?.emit(
          event("provider.attempt_failed", {
            traceId,
            requestId,
            providerId: provider.definition.id,
            modelId: candidate.model.id,
            failureCategory: normalized.category,
            retryCount: attempts.length - 1
          })
        );
        if (!policy.fallback || !normalized.retryable || normalized.category === "auth") break;
        this.telemetry?.emit(
          event("fallback.triggered", { traceId, requestId, retryCount: attempts.length })
        );
      }
    }
    await this.repository.saveTrace({
      traceId,
      requestId,
      createdAt: new Date(started).toISOString(),
      model: request.model,
      promptHash: safePromptHash(request),
      contentStored: false,
      latencyMs: Date.now() - started,
      attempts,
      routingDecision: decision
    });
    throw (
      lastError ??
      new PolyMindError(
        "Execution failed without a provider attempt",
        "execution_failed",
        502,
        "unknown",
        false
      )
    );
  }
}

function estimateCost(
  modelId: string,
  registry: ModelRegistry,
  usage?: TokenUsage
): number | undefined {
  const model = registry.model(modelId);
  if (!model || !usage) return undefined;
  if (
    model.inputCostPerMillionTokens === undefined &&
    model.outputCostPerMillionTokens === undefined
  )
    return undefined;
  return estimateConfiguredCost(model, usage.promptTokens, usage.completionTokens);
}
