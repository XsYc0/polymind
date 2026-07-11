import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, mergePolicy, redactSecrets, type PolyMindConfig } from "@polymind/config";
import {
  chatCompletionRequestSchema,
  modelDefinitionSchema,
  PolyMindError,
  providerDefinitionSchema,
  type ModelDefinition,
  type ProviderDefinition
} from "@polymind/contracts";
import {
  AnthropicProvider,
  DeepSeekProvider,
  GeminiProvider,
  OpenAIProvider
} from "@polymind/cloud-providers";
import { CognitiveEngine, type ExecutionPolicy } from "@polymind/cognitive-engine";
import { ExecutionEngine } from "@polymind/execution-engine";
import { ModelRegistry } from "@polymind/model-registry";
import { MockProvider } from "@polymind/mock-provider";
import { OllamaProvider } from "@polymind/ollama";
import { OpenAICompatibleProvider } from "@polymind/openai-compatible";
import { SqliteRepository, type PolyMindRepository } from "@polymind/persistence";
import { ProviderHealthScheduler, ProviderManager, type LlmProvider } from "@polymind/provider-sdk";
import { RoutingEngine } from "@polymind/router";
import { InMemoryTelemetrySink } from "@polymind/telemetry";

export interface AppComposition {
  app: FastifyInstance;
  config: PolyMindConfig;
  registry: ModelRegistry;
  repository: PolyMindRepository;
  telemetry: InMemoryTelemetrySink;
}

export async function buildApp(inputConfig?: PolyMindConfig): Promise<AppComposition> {
  let config = inputConfig ?? (await loadConfig());
  const repository = new SqliteRepository(config.storage.sqlitePath);
  const storedProviders = await repository.listProviders();
  const storedModels = await repository.listModels();
  if (storedProviders.length > 0 || storedModels.length > 0) {
    config = {
      ...config,
      providers: storedProviders.length > 0 ? storedProviders : config.providers,
      models: storedModels.length > 0 ? storedModels : config.models
    };
  }
  const registry = ModelRegistry.fromConfig(config);
  await repository.saveProviders(registry.listProviders());
  await repository.saveModels(registry.listModels());
  const telemetry = new InMemoryTelemetrySink();
  const providers = new ProviderManager();
  for (const provider of config.providers) {
    const models = config.models.filter((model) => model.providerId === provider.id);
    providers.register(createProvider(provider, models));
  }
  const router = new RoutingEngine({ balancedWeights: config.routing.balancedWeights, telemetry });
  const engine = new ExecutionEngine(registry, router, providers, repository, telemetry);
  const cognitiveEngine = new CognitiveEngine({ registry, executionEngine: engine, repository });
  const healthScheduler = new ProviderHealthScheduler(providers, 30_000);
  const app = Fastify({
    logger: {
      level: config.logging.level,
      redact: ["req.headers.authorization", "*.secretRef", "*.apiKey", "*.token", "*.password"]
    },
    bodyLimit: config.server.bodyLimitBytes,
    requestTimeout: config.server.requestTimeoutMs
  });
  await app.register(cors, { origin: false });
  healthScheduler.start();
  app.addHook("onClose", async () => {
    healthScheduler.stop();
    repository.close?.();
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/v1/runtime/status", async () => ({
    status: "ready",
    providers: providers.statuses(),
    scheduler: healthScheduler.status(),
    integrations: {
      omniroute: omnirouteStatus(config),
      ruflo: rufloStatus(config)
    }
  }));
  app.get("/v1/runtime/metrics", async () => ({
    traces: { count: (await repository.listTraces?.({ limit: 200 }))?.length ?? 0 },
    cache: (await repository.cacheStats?.()) ?? {
      entries: 0,
      hits: 0,
      misses: 0,
      invalidations: 0
    },
    providers: providers.statuses(),
    performance: await repository.modelPerformance?.()
  }));
  app.get("/v1/integrations", async () => ({
    object: "list",
    data: [omnirouteStatus(config), rufloStatus(config)]
  }));
  app.get("/v1/integrations/omniroute/status", async () => omnirouteStatus(config));
  app.get("/v1/integrations/ruflo/status", async () => rufloStatus(config));
  app.post("/v1/integrations/omniroute/health/check", async (request, reply) => {
    const denied = requireLocalAdmin(request, reply);
    if (denied) return denied;
    return checkOmniRoute(config);
  });
  app.get("/ready", async () => ({
    status: "ready",
    providers: registry.listProviders().length,
    models: registry.listModels().length
  }));
  app.get("/version", async () => ({ name: "polymind", version: "0.1.0" }));
  app.get("/v1/providers", async () => ({ object: "list", data: registry.listProviders() }));
  app.get<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId",
    async (request, reply) => {
      const provider = registry.provider(request.params.providerId);
      if (!provider)
        return reply
          .code(404)
          .send({ error: { message: "Provider not found", code: "provider_not_found" } });
      return { ...provider, runtime: providers.status(request.params.providerId) };
    }
  );
  app.get<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/health",
    async (request, reply) => {
      try {
        return (
          providers.status(request.params.providerId).health ??
          (await providers.healthCheck(request.params.providerId))
        );
      } catch (error) {
        const normalized = toApiError(error);
        return reply
          .code(normalized.statusCode)
          .send({ error: { message: normalized.message, code: normalized.code } });
      }
    }
  );
  app.get<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/health/history",
    async (request) => ({
      object: "list",
      data:
        (await repository.listHealthHistory?.(
          request.params.providerId,
          parseListQuery(request.query)
        )) ?? [providers.status(request.params.providerId)].filter((status) => status.health),
      pagination: pagination(request.query)
    })
  );
  app.get<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/performance",
    async (request) => ({
      object: "list",
      data: ((await repository.modelPerformance?.()) ?? []).filter(
        (item) => item.providerId === request.params.providerId
      )
    })
  );
  app.post<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/health/check",
    async (request, reply) => {
      const denied = requireLocalAdmin(request, reply);
      if (denied) return denied;
      try {
        const before = providers.status(request.params.providerId);
        const health = await providers.healthCheck(request.params.providerId);
        const after = providers.status(request.params.providerId);
        await repository.saveHealthObservation?.({
          providerId: request.params.providerId,
          source: "active",
          healthy: health.healthy,
          latencyMs: health.latencyMs,
          failureCategory: health.healthy ? undefined : "provider_unavailable",
          circuitBefore: before.circuitBreaker,
          circuitAfter: after.circuitBreaker,
          cooldownUntil: after.cooldownUntil,
          createdAt: new Date().toISOString(),
          metadata: health
        });
        return health;
      } catch (error) {
        const normalized = toApiError(error);
        return reply
          .code(normalized.statusCode)
          .send({ error: { message: normalized.message, code: normalized.code } });
      }
    }
  );
  app.post<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/enable",
    async (request, reply) => {
      const denied = requireLocalAdmin(request, reply);
      if (denied) return denied;
      return providers.enable(request.params.providerId);
    }
  );
  app.post<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/disable",
    async (request, reply) => {
      const denied = requireLocalAdmin(request, reply);
      if (denied) return denied;
      return providers.disable(request.params.providerId);
    }
  );
  app.post<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/models/refresh",
    async (request, reply) => {
      const denied = requireLocalAdmin(request, reply);
      if (denied) return denied;
      try {
        const models = await providers.get(request.params.providerId).listModels();
        return { object: "list", data: models };
      } catch (error) {
        const normalized = toApiError(error);
        return reply
          .code(normalized.statusCode)
          .send({ error: { message: normalized.message, code: normalized.code } });
      }
    }
  );
  app.post("/v1/providers", async (request, reply) => {
    const denied = requireLocalAdmin(request, reply);
    if (denied) return denied;
    try {
      const input = parseProviderMutation(request.body);
      if (registry.provider(input.provider.id)) {
        return reply.code(409).send({
          error: { message: "Provider id already exists", code: "provider_exists" }
        });
      }
      validateSafeSecret(input.provider);
      for (const model of input.models) modelDefinitionSchema.parse(model);
      const candidateConfig = {
        ...config,
        providers: [...config.providers, input.provider],
        models: [...config.models, ...input.models]
      };
      ModelRegistry.fromConfig(candidateConfig);
      if (input.dryRun) return { dryRun: true, provider: redactSecrets(input.provider) };
      await repository.saveProvider(input.provider);
      for (const model of input.models) await repository.saveModel(model);
      await repository.auditProviderChange(input.provider.id, "create", redactSecrets(input));
      registry.upsertProvider(input.provider);
      for (const model of input.models) registry.upsertModel(model);
      providers.register(createProvider(input.provider, input.models));
      config = candidateConfig;
      reply.code(201);
      return { provider: redactSecrets(input.provider), models: redactSecrets(input.models) };
    } catch (error) {
      const normalized = toApiError(error);
      return reply
        .code(normalized.statusCode)
        .send({ error: { message: normalized.message, code: normalized.code } });
    }
  });
  app.patch<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId",
    async (request, reply) => {
      const denied = requireLocalAdmin(request, reply);
      if (denied) return denied;
      try {
        const existing = config.providers.find(
          (provider) => provider.id === request.params.providerId
        );
        if (!existing) {
          return reply.code(404).send({
            error: { message: "Provider not found", code: "provider_not_found" }
          });
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        const patch = (body.provider ?? body) as Partial<ProviderDefinition>;
        if (patch.id && patch.id !== request.params.providerId) {
          throw new PolyMindError("Provider id cannot be changed", "provider_id_immutable", 400);
        }
        const provider = providerDefinitionSchema.parse({ ...existing, ...patch, id: existing.id });
        validateSafeSecret(provider);
        const candidateProviders = config.providers.map((item) =>
          item.id === provider.id ? provider : item
        );
        const candidateConfig = { ...config, providers: candidateProviders };
        ModelRegistry.fromConfig(candidateConfig);
        if (body.dryRun === true) return { dryRun: true, provider: redactSecrets(provider) };
        await repository.saveProvider(provider);
        await repository.auditProviderChange(provider.id, "update", redactSecrets(patch));
        registry.upsertProvider(provider);
        providers.register(
          createProvider(
            provider,
            config.models.filter((model) => model.providerId === provider.id)
          )
        );
        config = candidateConfig;
        return { provider: redactSecrets(provider) };
      } catch (error) {
        const normalized = toApiError(error);
        return reply
          .code(normalized.statusCode)
          .send({ error: { message: normalized.message, code: normalized.code } });
      }
    }
  );
  app.delete<{ Params: { providerId: string }; Querystring: { cascade?: string } }>(
    "/v1/providers/:providerId",
    async (request, reply) => {
      const denied = requireLocalAdmin(request, reply);
      if (denied) return denied;
      try {
        const cascade = request.query.cascade === "true";
        const referenced = config.models.filter(
          (model) => model.providerId === request.params.providerId
        );
        if (referenced.length > 0 && !cascade) {
          return reply.code(409).send({
            error: {
              message: "Provider has referenced models; pass cascade=true to delete them",
              code: "provider_delete_requires_cascade"
            }
          });
        }
        await repository.deleteModelsByProvider(request.params.providerId);
        await repository.deleteProvider(request.params.providerId);
        await repository.auditProviderChange(request.params.providerId, "delete", {
          cascade,
          modelIds: referenced.map((model) => model.id)
        });
        registry.deleteProvider(request.params.providerId, cascade);
        providers.unregister(request.params.providerId);
        config = {
          ...config,
          providers: config.providers.filter(
            (provider) => provider.id !== request.params.providerId
          ),
          models: config.models.filter((model) => model.providerId !== request.params.providerId)
        };
        return { deleted: true, cascade, modelIds: referenced.map((model) => model.id) };
      } catch (error) {
        const normalized = toApiError(error);
        return reply
          .code(normalized.statusCode)
          .send({ error: { message: normalized.message, code: normalized.code } });
      }
    }
  );
  app.get("/v1/models", async () => ({
    object: "list",
    data: registry.listModels().map((model) => ({
      id: model.id,
      object: "model",
      owned_by: model.providerId,
      polymind: model
    }))
  }));
  app.get<{ Params: { id: string } }>("/v1/models/:id", async (request, reply) => {
    const model = registry.model(request.params.id);
    if (!model)
      return reply
        .code(404)
        .send({ error: { message: "Model not found", code: "model_not_found" } });
    return { id: model.id, object: "model", owned_by: model.providerId, polymind: model };
  });
  app.get<{ Params: { modelId: string } }>("/v1/models/:modelId/performance", async (request) => ({
    object: "list",
    data: (await repository.modelPerformance?.(request.params.modelId)) ?? []
  }));
  app.get<{ Params: { modelId: string } }>(
    "/v1/models/:modelId/performance/by-task",
    async (request) => ({
      object: "list",
      data: (await repository.modelPerformance?.(request.params.modelId)) ?? [],
      groupedBy: "taskType"
    })
  );
  app.get("/v1/performance/leaderboard", async () => ({
    object: "list",
    data: ((await repository.modelPerformance?.()) ?? []).sort(
      (a, b) => b.successRate - a.successRate || (a.p50LatencyMs ?? 0) - (b.p50LatencyMs ?? 0)
    )
  }));
  app.get("/v1/traces", async (request) => ({
    object: "list",
    data: await repository.listTraces?.(parseListQuery(request.query)),
    pagination: pagination(request.query)
  }));
  app.get<{ Params: { traceId: string } }>("/v1/traces/:traceId", async (request, reply) => {
    const trace = await repository.getTrace(request.params.traceId);
    if (!trace)
      return reply
        .code(404)
        .send({ error: { message: "Trace not found", code: "trace_not_found" } });
    return trace;
  });
  app.get<{ Params: { traceId: string } }>("/v1/traces/:traceId/attempts", async (request) => ({
    object: "list",
    data: await repository.listAttempts?.(request.params.traceId)
  }));
  app.get<{ Params: { traceId: string } }>("/v1/traces/:traceId/events", async (request) => ({
    object: "list",
    data: telemetry.events.filter((item) => item.traceId === request.params.traceId)
  }));
  app.get("/v1/cache/stats", async () => (await repository.cacheStats?.()) ?? {});
  app.post("/v1/cache/purge", async (request, reply) => {
    const denied = requireLocalAdmin(request, reply);
    if (denied) return denied;
    return { purged: (await repository.purgeCache?.()) ?? 0 };
  });
  app.get("/v1/executions", async (request) => ({
    object: "list",
    data: await repository.listExecutions?.(parseListQuery(request.query)),
    pagination: pagination(request.query)
  }));
  app.post("/v1/executions", async (request, reply) => {
    try {
      const parsed = chatCompletionRequestSchema.parse(request.body);
      const result = await cognitiveEngine.execute(parsed, parseExecutionPolicy(parsed.polymind), {
        requestId: request.id,
        timeoutMs: config.server.requestTimeoutMs,
        storeRequestContent: config.storage.storeRequestContent
      });
      reply.header("x-polymind-execution-id", result.executionId);
      return result;
    } catch (error) {
      const normalized = toApiError(error);
      return reply
        .code(normalized.statusCode)
        .send({ error: { message: normalized.message, code: normalized.code } });
    }
  });
  app.get<{ Params: { executionId: string } }>(
    "/v1/executions/:executionId",
    async (request, reply) => {
      const execution = await repository.getExecution?.(request.params.executionId);
      if (!execution)
        return reply
          .code(404)
          .send({ error: { message: "Execution not found", code: "execution_not_found" } });
      return execution;
    }
  );
  app.get<{ Params: { executionId: string } }>(
    "/v1/executions/:executionId/plan",
    async (request) => ({
      plan: (await repository.getExecution?.(request.params.executionId))?.plan
    })
  );
  app.get<{ Params: { executionId: string } }>(
    "/v1/executions/:executionId/nodes",
    async (request) => ({
      object: "list",
      data:
        (
          (await repository.getExecution?.(request.params.executionId))?.plan as
            { nodes?: unknown[] } | undefined
        )?.nodes ?? []
    })
  );
  app.get<{ Params: { executionId: string } }>(
    "/v1/executions/:executionId/evaluations",
    async (request) => ({
      object: "list",
      data:
        ((await repository.getExecution?.(request.params.executionId))?.evaluations as unknown[]) ??
        []
    })
  );
  app.post<{ Params: { executionId: string } }>(
    "/v1/executions/:executionId/cancel",
    async (request) => ({
      executionId: request.params.executionId,
      cancelled: true
    })
  );
  app.get("/openapi.json", async () => openApiDocument());
  app.get("/v1/config", async () => redactSecrets(config));
  app.post("/v1/chat/completions", async (request, reply) => {
    try {
      const parsed = chatCompletionRequestSchema.parse(request.body);
      validateRouteDepth(request.headers, config);
      const mode = config.integrations.omniroute.routingMode;
      if (mode !== "native-only" && config.integrations.omniroute.enabled) {
        if (parsed.stream) {
          const delegated = await tryOmniRouteStream(parsed, request, reply, config);
          if (delegated.ok) return;
          if (mode === "omniroute-only" || !config.integrations.omniroute.fallbackToNative) {
            throw delegated.error;
          }
        } else {
          const delegated = await tryOmniRouteJson(parsed, request.headers, request.id, config);
          if (delegated.ok) {
            reply.header("x-polymind-trace-id", delegated.traceId ?? "");
            return delegated.data;
          }
          if (mode === "omniroute-only" || !config.integrations.omniroute.fallbackToNative) {
            throw delegated.error;
          }
        }
      }
      if (parsed.stream) {
        const abortController = new AbortController();
        request.raw.on("aborted", () => abortController.abort());
        const stream = engine.stream(
          parsed,
          mergePolicy(config, parsed.polymind as Record<string, unknown> | undefined),
          {
            requestId: request.id,
            timeoutMs: config.server.requestTimeoutMs,
            storeRequestContent: config.storage.storeRequestContent,
            signal: abortController.signal
          }
        );
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-polymind-trace-id": stream.traceId
        });
        let done = false;
        try {
          for await (const chunk of stream.chunks) {
            reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
          }
        } finally {
          if (!done) {
            done = true;
            reply.raw.write("data: [DONE]\n\n");
            reply.raw.end();
          }
        }
        return;
      }
      if (parsed.model.startsWith("polymind/") || hasCognitivePolicy(parsed.polymind)) {
        const result = await cognitiveEngine.execute(
          parsed,
          parseExecutionPolicy(parsed.polymind),
          {
            requestId: request.id,
            timeoutMs: config.server.requestTimeoutMs,
            storeRequestContent: config.storage.storeRequestContent
          }
        );
        reply.header("x-polymind-execution-id", result.executionId);
        reply.header(
          "x-polymind-trace-id",
          result.response.polymind?.traceId ?? result.executionId
        );
        return result.response;
      }
      const response = await engine.execute(
        parsed,
        mergePolicy(config, parsed.polymind as Record<string, unknown> | undefined),
        {
          requestId: request.id,
          timeoutMs: config.server.requestTimeoutMs,
          storeRequestContent: config.storage.storeRequestContent
        }
      );
      reply.header("x-polymind-trace-id", response.polymind?.traceId ?? "");
      return response;
    } catch (error) {
      if (reply.sent) return;
      const normalized = toApiError(error);
      return reply.code(normalized.statusCode).send({
        error: {
          message: normalized.message,
          type: normalized.category,
          code: normalized.code
        }
      });
    }
  });
  return { app, config, registry, repository, telemetry };
}

function omnirouteStatus(config: PolyMindConfig): Record<string, unknown> {
  return {
    id: "omniroute",
    enabled: config.integrations.omniroute.enabled,
    mode: config.integrations.omniroute.mode,
    baseUrl: config.integrations.omniroute.baseUrl,
    routingMode: config.integrations.omniroute.routingMode,
    fallbackToNative: config.integrations.omniroute.fallbackToNative,
    reviewed: {
      repositoryUrl: "https://github.com/diegosouzapw/OmniRoute",
      interface: "OpenAI-compatible HTTP gateway under /v1",
      dateReviewed: "2026-07-11",
      license: "repository license not vendored into PolyMind"
    }
  };
}

function rufloStatus(config: PolyMindConfig): Record<string, unknown> {
  return {
    id: "ruflo",
    enabled: config.integrations.ruflo.enabled,
    mode: config.integrations.ruflo.mode,
    endpoint: config.integrations.ruflo.endpoint,
    command: config.integrations.ruflo.command,
    routingMode: config.integrations.ruflo.routingMode,
    fallbackToNative: config.integrations.ruflo.fallbackToNative,
    maximumAgents: config.integrations.ruflo.maximumAgents,
    reviewed: {
      repositoryUrl: "https://github.com/ruflo/ruflo",
      documentedInterface: "CLI/MCP external orchestration boundary",
      dateReviewed: "2026-07-11",
      invocation: "npx ruflo@latest or external endpoint when configured",
      limitations: "PolyMind does not pass provider secrets and falls back natively when disabled."
    }
  };
}

function parseExecutionPolicy(value: unknown): Partial<ExecutionPolicy> {
  const input = (value ?? {}) as Record<string, unknown>;
  const modeMap: Record<string, ExecutionPolicy["mode"]> = {
    auto: "auto",
    direct: "direct",
    cascade: "cascade",
    specialist: "specialist",
    council: "council",
    workflow: "workflow",
    local: "local-only",
    "local-only": "local-only"
  };
  const mode = typeof input.mode === "string" ? modeMap[input.mode] : undefined;
  const budgetPreset =
    typeof input.budgetPreset === "string" &&
    ["economy", "balanced", "quality", "local-only", "custom"].includes(input.budgetPreset)
      ? (input.budgetPreset as ExecutionPolicy["budget"]["preset"])
      : undefined;
  const output: Partial<ExecutionPolicy> = {};
  if (mode) output.mode = mode;
  if (typeof input.cache === "boolean") output.cache = input.cache;
  if (typeof input.explain === "boolean") output.explain = input.explain;
  if (input.privacy === "local-only" || input.privacy === "private") output.privacy = input.privacy;
  if (input.ruflo === "only") output.ruflo = "ruflo-only";
  if (input.ruflo === "preferred") output.ruflo = "ruflo-preferred-with-native-fallback";
  if (input.ruflo === "native-only") output.ruflo = "native-only";
  if (budgetPreset) {
    output.budget = {
      preset: budgetPreset,
      maximumWallClockMs:
        typeof input.maximumLatencyMs === "number" ? input.maximumLatencyMs : 30_000,
      maximumProviderCalls: 4,
      maximumExecutionNodes: 12,
      maximumParallelCalls: 2,
      maximumCouncilParticipants: 3
    };
    if (typeof input.maximumCost === "number")
      output.budget.maximumEstimatedCost = input.maximumCost;
  }
  return output;
}

function hasCognitivePolicy(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  return Boolean(input.mode || input.budgetPreset || input.explain || input.ruflo || input.cache);
}

function parseListQuery(value: unknown): {
  limit?: number;
  offset?: number;
  providerId?: string;
  modelId?: string;
  strategy?: string;
  success?: boolean;
  since?: string;
  until?: string;
} {
  const query = (value ?? {}) as Record<string, unknown>;
  const output: {
    limit?: number;
    offset?: number;
    providerId?: string;
    modelId?: string;
    strategy?: string;
    success?: boolean;
    since?: string;
    until?: string;
  } = {};
  const limit = numberQuery(query.limit);
  const offset = numberQuery(query.offset);
  const providerId = stringQuery(query.providerId);
  const modelId = stringQuery(query.modelId);
  const strategy = stringQuery(query.strategy);
  const since = stringQuery(query.since);
  const until = stringQuery(query.until);
  if (limit !== undefined) output.limit = limit;
  if (offset !== undefined) output.offset = offset;
  if (providerId) output.providerId = providerId;
  if (modelId) output.modelId = modelId;
  if (strategy) output.strategy = strategy;
  if (query.success === "true") output.success = true;
  if (query.success === "false") output.success = false;
  if (since) output.since = since;
  if (until) output.until = until;
  return output;
}

function pagination(value: unknown): Record<string, number> {
  const query = parseListQuery(value);
  return { limit: Math.max(1, Math.min(query.limit ?? 50, 200)), offset: query.offset ?? 0 };
}

function numberQuery(value: unknown): number | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  const number = Number(resolved);
  return Number.isFinite(number) ? number : undefined;
}

function stringQuery(value: unknown): string | undefined {
  const resolved = Array.isArray(value) ? value[0] : value;
  return typeof resolved === "string" ? resolved : undefined;
}

export function openApiDocument(): Record<string, unknown> {
  const response = {
    description: "JSON response",
    content: { "application/json": { schema: { type: "object" } } }
  };
  const error = {
    description: "Error envelope",
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: { error: { type: "object" } }
        }
      }
    }
  };
  return {
    openapi: "3.1.0",
    info: { title: "PolyMind API", version: "0.1.0" },
    paths: Object.fromEntries(
      [
        ["GET", "/health"],
        ["GET", "/ready"],
        ["GET", "/version"],
        ["POST", "/v1/chat/completions"],
        ["GET", "/v1/runtime/status"],
        ["GET", "/v1/runtime/metrics"],
        ["GET", "/v1/providers"],
        ["POST", "/v1/providers"],
        ["GET", "/v1/providers/{providerId}"],
        ["PATCH", "/v1/providers/{providerId}"],
        ["DELETE", "/v1/providers/{providerId}"],
        ["GET", "/v1/providers/{providerId}/health"],
        ["GET", "/v1/providers/{providerId}/health/history"],
        ["GET", "/v1/providers/{providerId}/performance"],
        ["GET", "/v1/models"],
        ["GET", "/v1/models/{modelId}"],
        ["GET", "/v1/models/{modelId}/performance"],
        ["GET", "/v1/traces"],
        ["GET", "/v1/traces/{traceId}"],
        ["GET", "/v1/traces/{traceId}/attempts"],
        ["GET", "/v1/traces/{traceId}/events"],
        ["POST", "/v1/executions"],
        ["GET", "/v1/executions"],
        ["GET", "/v1/executions/{executionId}"],
        ["GET", "/v1/executions/{executionId}/plan"],
        ["GET", "/v1/executions/{executionId}/nodes"],
        ["GET", "/v1/executions/{executionId}/evaluations"],
        ["POST", "/v1/executions/{executionId}/cancel"],
        ["GET", "/v1/cache/stats"],
        ["POST", "/v1/cache/purge"],
        ["GET", "/v1/performance/leaderboard"],
        ["GET", "/v1/integrations"],
        ["GET", "/v1/integrations/omniroute/status"],
        ["GET", "/v1/integrations/ruflo/status"],
        ["GET", "/openapi.json"]
      ].map(([method, path]) => [
        path,
        {
          [(method ?? "GET").toLowerCase()]: {
            responses: { "200": response, "400": error, "500": error },
            "x-polymind": {
              streaming:
                path === "/v1/chat/completions"
                  ? "OpenAI-compatible SSE when request.stream=true"
                  : undefined
            }
          }
        }
      ])
    )
  };
}

async function checkOmniRoute(config: PolyMindConfig): Promise<Record<string, unknown>> {
  if (!config.integrations.omniroute.enabled) return { healthy: false, reason: "disabled" };
  const started = Date.now();
  try {
    const response = await fetch(
      new URL("models", ensureSlash(config.integrations.omniroute.baseUrl)),
      {
        headers: omnirouteHeaders(config, crypto.randomUUID(), 0),
        signal: AbortSignal.timeout(config.integrations.omniroute.timeoutMs)
      }
    );
    return {
      healthy: response.ok,
      statusCode: response.status,
      latencyMs: Date.now() - started
    };
  } catch (error) {
    return { healthy: false, latencyMs: Date.now() - started, reason: String(error) };
  }
}

async function tryOmniRouteJson(
  payload: unknown,
  incomingHeaders: Record<string, string | string[] | undefined>,
  requestId: string,
  config: PolyMindConfig
): Promise<{ ok: true; data: unknown; traceId?: string } | { ok: false; error: PolyMindError }> {
  const traceId = headerValue(incomingHeaders["x-polymind-trace-id"]) ?? requestId;
  const depth = Number(headerValue(incomingHeaders["x-polymind-route-depth"]) ?? "0") + 1;
  try {
    const response = await fetch(
      new URL("chat/completions", ensureSlash(config.integrations.omniroute.baseUrl)),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...omnirouteHeaders(config, traceId, depth)
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.integrations.omniroute.timeoutMs)
      }
    );
    if (!response.ok) {
      throw new PolyMindError(
        `OmniRoute delegation failed ${response.status}`,
        "omniroute_delegation_failed",
        response.status,
        response.status === 429 ? "rate_limit" : "provider_unavailable",
        true
      );
    }
    return { ok: true, data: await response.json(), traceId };
  } catch (error) {
    return { ok: false, error: toApiError(error) };
  }
}

async function tryOmniRouteStream(
  payload: unknown,
  request: { headers: Record<string, string | string[] | undefined>; id: string },
  reply: {
    hijack: () => void;
    raw: {
      writeHead: (status: number, headers: Record<string, string>) => void;
      write: (chunk: Uint8Array | string) => void;
      end: () => void;
    };
  },
  config: PolyMindConfig
): Promise<{ ok: true } | { ok: false; error: PolyMindError }> {
  const traceId = headerValue(request.headers["x-polymind-trace-id"]) ?? request.id;
  const depth = Number(headerValue(request.headers["x-polymind-route-depth"]) ?? "0") + 1;
  try {
    const response = await fetch(
      new URL("chat/completions", ensureSlash(config.integrations.omniroute.baseUrl)),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...omnirouteHeaders(config, traceId, depth)
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.integrations.omniroute.timeoutMs)
      }
    );
    if (!response.ok || !response.body) {
      throw new PolyMindError(
        `OmniRoute stream delegation failed ${response.status}`,
        "omniroute_stream_failed",
        response.status || 502,
        "provider_unavailable",
        true
      );
    }
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-polymind-trace-id": traceId
    });
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        reply.raw.write(value);
      }
    } finally {
      reader.releaseLock();
      reply.raw.end();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: toApiError(error) };
  }
}

function validateRouteDepth(
  headers: Record<string, string | string[] | undefined>,
  config: PolyMindConfig
): void {
  const origin = headerValue(headers["x-polymind-origin"]);
  if (origin === "polymind") {
    throw new PolyMindError("Routing loop detected", "routing_loop_detected", 508, "validation");
  }
  const depth = Number(headerValue(headers["x-polymind-route-depth"]) ?? "0");
  if (depth > config.integrations.omniroute.maxRouteDepth) {
    throw new PolyMindError(
      "Maximum route depth exceeded",
      "route_depth_exceeded",
      508,
      "validation"
    );
  }
}

function omnirouteHeaders(
  config: PolyMindConfig,
  traceId: string,
  depth: number
): Record<string, string> {
  return Object.fromEntries(
    Object.entries({
      authorization: resolveSecret(config.integrations.omniroute.secretRef)
        ? `Bearer ${resolveSecret(config.integrations.omniroute.secretRef)}`
        : undefined,
      "x-polymind-origin": "polymind",
      "x-polymind-trace-id": traceId,
      "x-polymind-route-depth": String(depth)
    }).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function createProvider(provider: ProviderDefinition, models: ModelDefinition[]): LlmProvider {
  if (provider.type === "mock") return new MockProvider(provider, models);
  if (provider.type === "ollama") return new OllamaProvider(provider, models);
  if (provider.type === "openai-compatible") {
    return new OpenAICompatibleProvider(provider, models, resolveSecret);
  }
  if (provider.type === "openai") return new OpenAIProvider(provider, models, { resolveSecret });
  if (provider.type === "anthropic")
    return new AnthropicProvider(provider, models, { resolveSecret });
  if (provider.type === "gemini") return new GeminiProvider(provider, models, { resolveSecret });
  if (provider.type === "deepseek")
    return new DeepSeekProvider(provider, models, { resolveSecret });
  throw new PolyMindError(
    `Unsupported provider type: ${provider.type}`,
    "unsupported_provider",
    400
  );
}

function parseProviderMutation(body: unknown): {
  provider: ProviderDefinition;
  models: ModelDefinition[];
  dryRun: boolean;
} {
  const record = (body ?? {}) as Record<string, unknown>;
  const providerInput = (record.provider ?? record) as Record<string, unknown>;
  const provider = providerDefinitionSchema.parse(providerInput);
  const models = ((record.models ?? providerInput.models ?? []) as unknown[]).map((model) =>
    modelDefinitionSchema.parse(model)
  );
  return { provider, models, dryRun: record.dryRun === true };
}

function validateSafeSecret(provider: ProviderDefinition): void {
  const metadata = provider.metadata as Record<string, unknown>;
  if (metadata.apiKey || metadata.token || metadata.password || metadata.secret) {
    throw new PolyMindError(
      "Raw secret values are rejected; use secretRef env:NAME",
      "raw_secret_rejected",
      400
    );
  }
  if (provider.secretRef && !provider.secretRef.startsWith("env:")) {
    throw new PolyMindError(
      "Only environment variable secret references are supported",
      "secret_ref_unsupported",
      400
    );
  }
}

function requireLocalAdmin(
  request: { ip: string },
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } }
): unknown | undefined {
  if (["127.0.0.1", "::1", "localhost"].includes(request.ip)) return undefined;
  return reply.code(403).send({
    error: {
      message: "Provider administration is limited to local admin requests",
      code: "local_admin_required"
    }
  });
}

function resolveSecret(secretRef?: string): string | undefined {
  if (!secretRef) return undefined;
  if (secretRef.startsWith("env:")) return process.env[secretRef.slice(4)];
  return undefined;
}

function toApiError(error: unknown): PolyMindError {
  if (error instanceof PolyMindError) return error;
  if (error instanceof Error) return new PolyMindError(error.message, "internal_error", 500);
  return new PolyMindError(String(error), "internal_error", 500);
}
