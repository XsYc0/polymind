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
      omniroute: omnirouteStatus(config)
    }
  }));
  app.get("/v1/integrations", async () => ({
    object: "list",
    data: [omnirouteStatus(config)]
  }));
  app.get("/v1/integrations/omniroute/status", async () => omnirouteStatus(config));
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
      data: [providers.status(request.params.providerId)].filter((status) => status.health)
    })
  );
  app.post<{ Params: { providerId: string } }>(
    "/v1/providers/:providerId/health/check",
    async (request, reply) => {
      const denied = requireLocalAdmin(request, reply);
      if (denied) return denied;
      try {
        return await providers.healthCheck(request.params.providerId);
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
  app.get<{ Params: { traceId: string } }>("/v1/traces/:traceId", async (request, reply) => {
    const trace = await repository.getTrace(request.params.traceId);
    if (!trace)
      return reply
        .code(404)
        .send({ error: { message: "Trace not found", code: "trace_not_found" } });
    return trace;
  });
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
