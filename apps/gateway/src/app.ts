import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { loadConfig, mergePolicy, redactSecrets, type PolyMindConfig } from "@polymind/config";
import { chatCompletionRequestSchema, PolyMindError } from "@polymind/contracts";
import { ExecutionEngine } from "@polymind/execution-engine";
import { ModelRegistry } from "@polymind/model-registry";
import { MockProvider } from "@polymind/mock-provider";
import { OllamaProvider } from "@polymind/ollama";
import { OpenAICompatibleProvider } from "@polymind/openai-compatible";
import { SqliteRepository, type PolyMindRepository } from "@polymind/persistence";
import { ProviderManager } from "@polymind/provider-sdk";
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
  const config = inputConfig ?? (await loadConfig());
  const registry = ModelRegistry.fromConfig(config);
  const repository = new SqliteRepository(config.storage.sqlitePath);
  await repository.saveProviders(registry.listProviders());
  await repository.saveModels(registry.listModels());
  const telemetry = new InMemoryTelemetrySink();
  const providers = new ProviderManager();
  for (const provider of config.providers) {
    const models = config.models.filter((model) => model.providerId === provider.id);
    if (provider.type === "mock") providers.register(new MockProvider(provider, models));
    if (provider.type === "ollama") providers.register(new OllamaProvider(provider, models));
    if (provider.type === "openai-compatible") {
      providers.register(new OpenAICompatibleProvider(provider, models, resolveSecret));
    }
  }
  const router = new RoutingEngine({ balancedWeights: config.routing.balancedWeights, telemetry });
  const engine = new ExecutionEngine(registry, router, providers, repository, telemetry);
  const app = Fastify({
    logger: {
      level: config.logging.level,
      redact: ["req.headers.authorization", "*.secretRef", "*.apiKey", "*.token", "*.password"]
    },
    bodyLimit: config.server.bodyLimitBytes,
    requestTimeout: config.server.requestTimeoutMs
  });
  await app.register(cors, { origin: false });

  app.get("/health", async () => ({ status: "ok" }));
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
    const parsed = request.body;
    reply.code(501);
    return {
      error: {
        message: "Runtime provider mutation is intentionally deferred; edit config and restart.",
        details: redactSecrets(parsed)
      }
    };
  });
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
