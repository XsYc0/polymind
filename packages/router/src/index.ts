import type {
  ChatCompletionRequest,
  ModelCapability,
  ModelDefinition,
  RoutingPolicy
} from "@polymind/contracts";
import { PolyMindError } from "@polymind/contracts";
import { estimateConfiguredCost, ModelRegistry } from "@polymind/model-registry";
import type { ProviderHealth } from "@polymind/provider-sdk";
import type { TelemetrySink } from "@polymind/telemetry";
import { event } from "@polymind/telemetry";

export interface ScoreBreakdown {
  quality: number;
  cost: number;
  latency: number;
  health: number;
  localPreference: number;
  failurePenalty: number;
  total: number;
}

export interface RouteCandidate {
  model: ModelDefinition;
  score: ScoreBreakdown;
}

export interface RouteDecision {
  strategy: RoutingPolicy["strategy"];
  reason: string;
  candidates: RouteCandidate[];
}

export interface RouterOptions {
  balancedWeights?: {
    quality: number;
    cost: number;
    latency: number;
    health: number;
    localPreference: number;
  };
  recentFailures?: Map<string, number>;
  telemetry?: TelemetrySink;
}

export class RoutingEngine {
  constructor(private readonly options: RouterOptions = {}) {}

  route(input: {
    request: ChatCompletionRequest;
    policy: RoutingPolicy;
    registry: ModelRegistry;
    health: Map<string, ProviderHealth>;
    traceId: string;
    requestId: string;
  }): RouteDecision {
    const required = new Set<ModelCapability>([
      "chat",
      ...(input.policy.requiredCapabilities ?? []),
      ...(input.request.stream ? (["streaming"] as ModelCapability[]) : []),
      ...(input.request.tools ? (["tool-use"] as ModelCapability[]) : []),
      ...(input.request.response_format ? (["structured-output"] as ModelCapability[]) : [])
    ]);
    const policy = { ...input.policy, requiredCapabilities: [...required] };
    this.options.telemetry?.emit(
      event("routing.started", {
        traceId: input.traceId,
        requestId: input.requestId,
        strategy: policy.strategy
      })
    );
    const eligible = input.registry
      .candidates(policy)
      .filter((model) => {
        const health = input.health.get(model.providerId);
        return health?.healthy ?? true;
      })
      .map((model) => ({
        model,
        score: this.score(model, policy, input.health.get(model.providerId))
      }));
    if (eligible.length === 0) {
      throw new PolyMindError(
        "No eligible model matched the routing policy",
        "no_eligible_model",
        400,
        "validation",
        false
      );
    }
    const ordered = this.order(eligible, policy.strategy);
    this.options.telemetry?.emit(
      event("routing.candidates_evaluated", {
        traceId: input.traceId,
        requestId: input.requestId,
        strategy: policy.strategy,
        metadata: {
          candidates: ordered.map((candidate) => ({
            modelId: candidate.model.id,
            score: candidate.score
          }))
        }
      })
    );
    const selected = ordered[0];
    if (!selected)
      throw new PolyMindError("No route candidate selected", "no_route_candidate", 500);
    this.options.telemetry?.emit(
      event("routing.model_selected", {
        traceId: input.traceId,
        requestId: input.requestId,
        providerId: selected.model.providerId,
        modelId: selected.model.id,
        strategy: policy.strategy
      })
    );
    return {
      strategy: policy.strategy,
      reason: `${policy.strategy} selected ${selected.model.id} from ${ordered.length} eligible candidate(s)`,
      candidates: ordered
    };
  }

  private score(
    model: ModelDefinition,
    policy: RoutingPolicy,
    health?: ProviderHealth
  ): ScoreBreakdown {
    const weights = this.options.balancedWeights ?? {
      quality: 0.45,
      cost: 0.2,
      latency: 0.2,
      health: 0.1,
      localPreference: 0.05
    };
    const estimatedCost = estimateConfiguredCost(model, 1000, 1000);
    const cost = 1 / (1 + estimatedCost);
    const latency = model.relativeSpeed;
    const healthScore =
      health?.healthy === false ? 0 : health?.latencyMs ? 1 / (1 + health.latencyMs / 1000) : 1;
    const localPreference = model.privacyClass === "local" || policy.localOnly ? 1 : 0;
    const failurePenalty = Math.min(0.5, (this.options.recentFailures?.get(model.id) ?? 0) * 0.1);
    const total =
      model.relativeQuality * weights.quality +
      cost * weights.cost +
      latency * weights.latency +
      healthScore * weights.health +
      localPreference * weights.localPreference -
      failurePenalty;
    return {
      quality: model.relativeQuality,
      cost,
      latency,
      health: healthScore,
      localPreference,
      failurePenalty,
      total: Number(total.toFixed(6))
    };
  }

  private order(
    candidates: RouteCandidate[],
    strategy: RoutingPolicy["strategy"]
  ): RouteCandidate[] {
    return [...candidates].sort((a, b) => {
      const value = compareByStrategy(a, b, strategy);
      return value === 0 ? a.model.id.localeCompare(b.model.id) : value;
    });
  }
}

function compareByStrategy(
  a: RouteCandidate,
  b: RouteCandidate,
  strategy: RoutingPolicy["strategy"]
): number {
  if (strategy === "lowest-cost") {
    return a.score.cost === b.score.cost ? 0 : b.score.cost - a.score.cost;
  }
  if (strategy === "lowest-latency") return b.model.relativeSpeed - a.model.relativeSpeed;
  if (strategy === "local-first") {
    const local =
      Number(b.model.privacyClass === "local") - Number(a.model.privacyClass === "local");
    return local || b.score.total - a.score.total;
  }
  if (strategy === "fallback-chain" || strategy === "direct") {
    return 0;
  }
  return b.score.total - a.score.total;
}
