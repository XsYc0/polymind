import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  ChatCompletionRequest,
  ModelDefinition,
  ProviderDefinition,
  TokenUsage
} from "@polymind/contracts";

export interface ExecutionAttemptRecord {
  providerId: string;
  modelId: string;
  startedAt: string;
  latencyMs?: number | undefined;
  success: boolean;
  failureCategory?: string | undefined;
  errorMessage?: string | undefined;
}

export interface TraceRecord {
  traceId: string;
  requestId: string;
  createdAt: string;
  model: string;
  promptHash: string;
  contentStored: boolean;
  requestContent?: unknown;
  responseContent?: unknown;
  selectedProviderId?: string | undefined;
  selectedModelId?: string | undefined;
  strategy?: string | undefined;
  routingReason?: string | undefined;
  usage?: TokenUsage | undefined;
  estimatedCost?: number | undefined;
  latencyMs?: number | undefined;
  attempts: ExecutionAttemptRecord[];
  routingDecision?: unknown;
}

export interface PolyMindRepository {
  saveProviders(providers: ProviderDefinition[]): Promise<void>;
  saveProvider(provider: ProviderDefinition): Promise<void>;
  listProviders(): Promise<ProviderDefinition[]>;
  deleteProvider(providerId: string): Promise<void>;
  saveModels(models: ModelDefinition[]): Promise<void>;
  saveModel(model: ModelDefinition): Promise<void>;
  listModels(): Promise<ModelDefinition[]>;
  deleteModelsByProvider(providerId: string): Promise<void>;
  auditProviderChange(providerId: string, action: string, details: unknown): Promise<void>;
  saveTrace(trace: TraceRecord): Promise<void>;
  getTrace(traceId: string): Promise<TraceRecord | undefined>;
  listTraces?(query?: ListQuery): Promise<TraceRecord[]>;
  listAttempts?(traceId: string): Promise<ExecutionAttemptRecord[]>;
  saveHealthObservation?(observation: ProviderHealthObservation): Promise<void>;
  listHealthHistory?(providerId: string, query?: ListQuery): Promise<ProviderHealthObservation[]>;
  saveExecutionPlan?(execution: ExecutionRecord): Promise<void>;
  getExecution?(executionId: string): Promise<ExecutionRecord | undefined>;
  listExecutions?(query?: ListQuery): Promise<ExecutionRecord[]>;
  saveCacheEntry?(entry: CacheRecord): Promise<void>;
  cacheStats?(): Promise<{ entries: number; hits: number; misses: number; invalidations: number }>;
  purgeCache?(): Promise<number>;
  modelPerformance?(modelId?: string): Promise<PerformanceSummary[]>;
  close?(): void;
}

export interface ListQuery {
  limit?: number | undefined;
  offset?: number | undefined;
  providerId?: string | undefined;
  modelId?: string | undefined;
  strategy?: string | undefined;
  success?: boolean | undefined;
  since?: string | undefined;
  until?: string | undefined;
}

export interface ProviderHealthObservation {
  providerId: string;
  modelId?: string | undefined;
  source: "active" | "passive";
  healthy: boolean;
  latencyMs?: number | undefined;
  failureCategory?: string | undefined;
  circuitBefore?: string | undefined;
  circuitAfter?: string | undefined;
  cooldownUntil?: string | undefined;
  createdAt: string;
  metadata?: unknown;
}

export interface ExecutionRecord {
  executionId: string;
  createdAt: string;
  mode: string;
  taskType: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  plan: unknown;
  profile?: unknown;
  evaluations?: unknown;
  explanation?: unknown;
  budget?: unknown;
}

export interface CacheRecord {
  key: string;
  partition: string;
  promptHash: string;
  hit: boolean;
  createdAt: string;
  expiresAt?: string | undefined;
  metadata?: unknown;
}

export interface PerformanceSummary {
  providerId?: string | undefined;
  modelId?: string | undefined;
  sampleCount: number;
  successRate: number;
  p50LatencyMs?: number | undefined;
  p95LatencyMs?: number | undefined;
  averageLatencyMs?: number | undefined;
  fallbackCount: number;
}

export class InMemoryRepository implements PolyMindRepository {
  readonly providers = new Map<string, ProviderDefinition>();
  readonly models = new Map<string, ModelDefinition>();
  readonly traces = new Map<string, TraceRecord>();

  async saveProviders(providers: ProviderDefinition[]): Promise<void> {
    for (const provider of providers) this.providers.set(provider.id, provider);
  }
  async saveProvider(provider: ProviderDefinition): Promise<void> {
    this.providers.set(provider.id, provider);
  }
  async listProviders(): Promise<ProviderDefinition[]> {
    return [...this.providers.values()];
  }
  async deleteProvider(providerId: string): Promise<void> {
    this.providers.delete(providerId);
  }
  async saveModels(models: ModelDefinition[]): Promise<void> {
    for (const model of models) this.models.set(model.id, model);
  }
  async saveModel(model: ModelDefinition): Promise<void> {
    this.models.set(model.id, model);
  }
  async listModels(): Promise<ModelDefinition[]> {
    return [...this.models.values()];
  }
  async deleteModelsByProvider(providerId: string): Promise<void> {
    for (const model of this.models.values()) {
      if (model.providerId === providerId) this.models.delete(model.id);
    }
  }
  async auditProviderChange(): Promise<void> {}
  async saveTrace(trace: TraceRecord): Promise<void> {
    this.traces.set(trace.traceId, trace);
  }
  async getTrace(traceId: string): Promise<TraceRecord | undefined> {
    return this.traces.get(traceId);
  }
  async listTraces(): Promise<TraceRecord[]> {
    return [...this.traces.values()];
  }
  async listAttempts(traceId: string): Promise<ExecutionAttemptRecord[]> {
    return this.traces.get(traceId)?.attempts ?? [];
  }
  async saveHealthObservation(): Promise<void> {}
  async listHealthHistory(): Promise<ProviderHealthObservation[]> {
    return [];
  }
  async saveExecutionPlan(): Promise<void> {}
  async getExecution(): Promise<ExecutionRecord | undefined> {
    return undefined;
  }
  async listExecutions(): Promise<ExecutionRecord[]> {
    return [];
  }
  async saveCacheEntry(): Promise<void> {}
  async cacheStats(): Promise<{
    entries: number;
    hits: number;
    misses: number;
    invalidations: number;
  }> {
    return { entries: 0, hits: 0, misses: 0, invalidations: 0 };
  }
  async purgeCache(): Promise<number> {
    return 0;
  }
  async modelPerformance(): Promise<PerformanceSummary[]> {
    return [];
  }
  close(): void {}
}

export class SqliteRepository implements PolyMindRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  async saveProviders(providers: ProviderDefinition[]): Promise<void> {
    const statement = this.db.prepare("insert or replace into providers(id, json) values (?, ?)");
    for (const provider of providers) statement.run(provider.id, JSON.stringify(provider));
  }

  async saveProvider(provider: ProviderDefinition): Promise<void> {
    this.db
      .prepare("insert or replace into providers(id, json) values (?, ?)")
      .run(provider.id, JSON.stringify(provider));
  }

  async listProviders(): Promise<ProviderDefinition[]> {
    return this.db
      .prepare("select json from providers order by id")
      .all()
      .map((row) => JSON.parse((row as { json: string }).json) as ProviderDefinition);
  }

  async deleteProvider(providerId: string): Promise<void> {
    this.db.prepare("delete from providers where id = ?").run(providerId);
  }

  async saveModels(models: ModelDefinition[]): Promise<void> {
    const statement = this.db.prepare(
      "insert or replace into models(id, provider_id, json) values (?, ?, ?)"
    );
    for (const model of models) statement.run(model.id, model.providerId, JSON.stringify(model));
  }

  async saveModel(model: ModelDefinition): Promise<void> {
    this.db
      .prepare("insert or replace into models(id, provider_id, json) values (?, ?, ?)")
      .run(model.id, model.providerId, JSON.stringify(model));
  }

  async listModels(): Promise<ModelDefinition[]> {
    return this.db
      .prepare("select json from models order by id")
      .all()
      .map((row) => JSON.parse((row as { json: string }).json) as ModelDefinition);
  }

  async deleteModelsByProvider(providerId: string): Promise<void> {
    this.db.prepare("delete from models where provider_id = ?").run(providerId);
  }

  async auditProviderChange(providerId: string, action: string, details: unknown): Promise<void> {
    this.db
      .prepare(
        "insert into provider_config_audit(provider_id, action, json, created_at) values (?, ?, ?, ?)"
      )
      .run(providerId, action, JSON.stringify(details), new Date().toISOString());
  }

  async saveTrace(trace: TraceRecord): Promise<void> {
    this.db
      .prepare("insert or replace into traces(trace_id, request_id, json) values (?, ?, ?)")
      .run(trace.traceId, trace.requestId, JSON.stringify(trace));
    const statement = this.db.prepare(
      "insert into execution_attempts(trace_id, provider_id, model_id, success, json) values (?, ?, ?, ?, ?)"
    );
    for (const attempt of trace.attempts) {
      statement.run(
        trace.traceId,
        attempt.providerId,
        attempt.modelId,
        attempt.success ? 1 : 0,
        JSON.stringify(attempt)
      );
    }
    for (const attempt of trace.attempts) {
      this.db
        .prepare(
          "insert into model_performance_observations(provider_id, model_id, latency_ms, first_token_latency_ms, success, json, created_at) values (?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          attempt.providerId,
          attempt.modelId,
          attempt.latencyMs ?? null,
          null,
          attempt.success ? 1 : 0,
          JSON.stringify(attempt),
          attempt.startedAt
        );
    }
  }

  async getTrace(traceId: string): Promise<TraceRecord | undefined> {
    const row = this.db.prepare("select json from traces where trace_id = ?").get(traceId) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as TraceRecord) : undefined;
  }

  async listTraces(query: ListQuery = {}): Promise<TraceRecord[]> {
    const rows = this.db
      .prepare("select json from traces order by trace_id desc limit ? offset ?")
      .all(boundLimit(query.limit), query.offset ?? 0) as Array<{ json: string }>;
    return rows
      .map((row) => JSON.parse(row.json) as TraceRecord)
      .filter((trace) => {
        if (query.providerId && trace.selectedProviderId !== query.providerId) return false;
        if (query.modelId && trace.selectedModelId !== query.modelId) return false;
        if (query.strategy && trace.strategy !== query.strategy) return false;
        if (query.since && trace.createdAt < query.since) return false;
        if (query.until && trace.createdAt > query.until) return false;
        if (
          query.success !== undefined &&
          trace.attempts.every((attempt) => attempt.success) !== query.success
        ) {
          return false;
        }
        return true;
      });
  }

  async listAttempts(traceId: string): Promise<ExecutionAttemptRecord[]> {
    const rows = this.db
      .prepare("select json from execution_attempts where trace_id = ? order by id asc")
      .all(traceId) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as ExecutionAttemptRecord);
  }

  async saveHealthObservation(observation: ProviderHealthObservation): Promise<void> {
    this.db
      .prepare(
        "insert into provider_health_history(provider_id, healthy, latency_ms, reason, json, created_at) values (?, ?, ?, ?, ?, ?)"
      )
      .run(
        observation.providerId,
        observation.healthy ? 1 : 0,
        observation.latencyMs ?? null,
        observation.failureCategory ?? null,
        JSON.stringify(observation),
        observation.createdAt
      );
  }

  async listHealthHistory(
    providerId: string,
    query: ListQuery = {}
  ): Promise<ProviderHealthObservation[]> {
    const rows = this.db
      .prepare(
        "select json from provider_health_history where provider_id = ? order by created_at desc limit ? offset ?"
      )
      .all(providerId, boundLimit(query.limit), query.offset ?? 0) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as ProviderHealthObservation);
  }

  async saveExecutionPlan(execution: ExecutionRecord): Promise<void> {
    this.db
      .prepare(
        "insert or replace into execution_plans(execution_id, mode, task_type, status, json, created_at) values (?, ?, ?, ?, ?, ?)"
      )
      .run(
        execution.executionId,
        execution.mode,
        execution.taskType,
        execution.status,
        JSON.stringify(execution),
        execution.createdAt
      );
  }

  async getExecution(executionId: string): Promise<ExecutionRecord | undefined> {
    const row = this.db
      .prepare("select json from execution_plans where execution_id = ?")
      .get(executionId) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as ExecutionRecord) : undefined;
  }

  async listExecutions(query: ListQuery = {}): Promise<ExecutionRecord[]> {
    const rows = this.db
      .prepare("select json from execution_plans order by created_at desc limit ? offset ?")
      .all(boundLimit(query.limit), query.offset ?? 0) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as ExecutionRecord);
  }

  async saveCacheEntry(entry: CacheRecord): Promise<void> {
    this.db
      .prepare(
        "insert into cache_lookup_events(cache_key, partition, hit, json, created_at) values (?, ?, ?, ?, ?)"
      )
      .run(entry.key, entry.partition, entry.hit ? 1 : 0, JSON.stringify(entry), entry.createdAt);
    this.db
      .prepare(
        "insert or replace into cache_entries(cache_key, partition, prompt_hash, json, expires_at, created_at) values (?, ?, ?, ?, ?, ?)"
      )
      .run(
        entry.key,
        entry.partition,
        entry.promptHash,
        JSON.stringify(entry),
        entry.expiresAt ?? null,
        entry.createdAt
      );
  }

  async cacheStats(): Promise<{
    entries: number;
    hits: number;
    misses: number;
    invalidations: number;
  }> {
    const entries = this.db.prepare("select count(*) as count from cache_entries").get() as {
      count: number;
    };
    const hits = this.db
      .prepare("select count(*) as count from cache_lookup_events where hit = 1")
      .get() as { count: number };
    const misses = this.db
      .prepare("select count(*) as count from cache_lookup_events where hit = 0")
      .get() as { count: number };
    const invalidations = this.db
      .prepare("select count(*) as count from cache_invalidations")
      .get() as { count: number };
    return {
      entries: entries.count,
      hits: hits.count,
      misses: misses.count,
      invalidations: invalidations.count
    };
  }

  async purgeCache(): Promise<number> {
    const entries = this.db.prepare("select count(*) as count from cache_entries").get() as {
      count: number;
    };
    this.db.prepare("delete from cache_entries").run();
    this.db
      .prepare("insert into cache_invalidations(reason, json, created_at) values (?, ?, ?)")
      .run("manual-purge", JSON.stringify({ deleted: entries.count }), new Date().toISOString());
    return entries.count;
  }

  async modelPerformance(modelId?: string): Promise<PerformanceSummary[]> {
    const rows = (
      modelId
        ? this.db
            .prepare(
              "select provider_id, model_id, latency_ms, success from model_performance_observations where model_id = ?"
            )
            .all(modelId)
        : this.db
            .prepare(
              "select provider_id, model_id, latency_ms, success from model_performance_observations"
            )
            .all()
    ) as Array<{
      provider_id: string;
      model_id: string;
      latency_ms: number | null;
      success: number;
    }>;
    const groups = new Map<
      string,
      Array<{ provider_id: string; model_id: string; latency_ms: number | null; success: number }>
    >();
    for (const row of rows) {
      const key = `${row.provider_id}:${row.model_id}`;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.values()].map((items) => {
      const latencies = items
        .map((item) => item.latency_ms)
        .filter((value): value is number => typeof value === "number")
        .sort((a, b) => a - b);
      const success = items.filter((item) => item.success === 1).length;
      return {
        providerId: items[0]?.provider_id,
        modelId: items[0]?.model_id,
        sampleCount: items.length,
        successRate: items.length ? success / items.length : 0,
        averageLatencyMs: latencies.length
          ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length
          : undefined,
        p50LatencyMs: percentile(latencies, 0.5),
        p95LatencyMs: percentile(latencies, 0.95),
        fallbackCount: items.length - success
      };
    });
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      create table if not exists schema_migrations(version integer primary key);
      create table if not exists providers(id text primary key, json text not null);
      create table if not exists models(id text primary key, provider_id text not null, json text not null);
      create table if not exists traces(trace_id text primary key, request_id text not null, json text not null);
      create table if not exists execution_attempts(
        id integer primary key autoincrement,
        trace_id text not null,
        provider_id text not null,
        model_id text not null,
        success integer not null,
        json text not null
      );
      create table if not exists provider_runtime_state(
        provider_id text primary key,
        state text not null,
        json text not null,
        updated_at text not null
      );
      create table if not exists provider_config_audit(
        id integer primary key autoincrement,
        provider_id text not null,
        action text not null,
        json text not null,
        created_at text not null
      );
      create table if not exists provider_health_history(
        id integer primary key autoincrement,
        provider_id text not null,
        healthy integer not null,
        latency_ms integer,
        reason text,
        json text not null,
        created_at text not null
      );
      create table if not exists circuit_breaker_transitions(
        id integer primary key autoincrement,
        provider_id text not null,
        from_state text,
        to_state text not null,
        reason text,
        created_at text not null
      );
      create table if not exists model_performance_observations(
        id integer primary key autoincrement,
        provider_id text not null,
        model_id text not null,
        latency_ms integer,
        first_token_latency_ms integer,
        success integer not null,
        json text not null,
        created_at text not null
      );
      create table if not exists stream_metrics(
        id integer primary key autoincrement,
        trace_id text not null,
        provider_id text,
        model_id text,
        chunk_count integer not null,
        output_characters integer not null,
        partial integer not null,
        json text not null,
        created_at text not null
      );
      create table if not exists fallback_events(
        id integer primary key autoincrement,
        trace_id text not null,
        provider_id text,
        model_id text,
        reason text not null,
        json text not null,
        created_at text not null
      );
      create table if not exists integration_runtime_status(
        integration_id text primary key,
        state text not null,
        json text not null,
        updated_at text not null
      );
      create table if not exists provider_lifecycle_events(
        id integer primary key autoincrement,
        provider_id text not null,
        event text not null,
        json text not null,
        created_at text not null
      );
      create table if not exists execution_plans(
        execution_id text primary key,
        mode text not null,
        task_type text not null,
        status text not null,
        json text not null,
        created_at text not null
      );
      create table if not exists execution_nodes(
        id integer primary key autoincrement,
        execution_id text not null,
        node_id text not null,
        status text not null,
        json text not null,
        created_at text not null
      );
      create table if not exists evaluations(
        id integer primary key autoincrement,
        execution_id text not null,
        node_id text,
        passed integer not null,
        score real not null,
        json text not null,
        created_at text not null
      );
      create table if not exists confidence_signals(
        id integer primary key autoincrement,
        execution_id text not null,
        name text not null,
        score real not null,
        json text not null,
        created_at text not null
      );
      create table if not exists budgets(
        execution_id text primary key,
        json text not null,
        created_at text not null
      );
      create table if not exists cache_entries(
        cache_key text primary key,
        partition text not null,
        prompt_hash text not null,
        json text not null,
        expires_at text,
        created_at text not null
      );
      create table if not exists cache_lookup_events(
        id integer primary key autoincrement,
        cache_key text not null,
        partition text not null,
        hit integer not null,
        json text not null,
        created_at text not null
      );
      create table if not exists cache_invalidations(
        id integer primary key autoincrement,
        reason text not null,
        json text not null,
        created_at text not null
      );
      create table if not exists shadow_evaluations(
        id integer primary key autoincrement,
        execution_id text not null,
        json text not null,
        created_at text not null
      );
      create table if not exists context_compression_metrics(
        id integer primary key autoincrement,
        execution_id text,
        original_tokens integer not null,
        final_tokens integer not null,
        json text not null,
        created_at text not null
      );
      create table if not exists ruflo_integration_runs(
        id integer primary key autoincrement,
        execution_id text,
        status text not null,
        json text not null,
        created_at text not null
      );
      create table if not exists tool_executions(
        id integer primary key autoincrement,
        execution_id text,
        tool_name text not null,
        status text not null,
        json text not null,
        created_at text not null
      );
      create table if not exists execution_cancellations(
        execution_id text primary key,
        reason text,
        json text not null,
        created_at text not null
      );
      create index if not exists idx_traces_request_id on traces(request_id);
      create index if not exists idx_attempts_trace_id on execution_attempts(trace_id);
      create index if not exists idx_health_provider_created on provider_health_history(provider_id, created_at);
      create index if not exists idx_model_perf_model on model_performance_observations(model_id, created_at);
      create index if not exists idx_execution_plans_created on execution_plans(created_at);
      insert or ignore into schema_migrations(version) values (1);
      insert or ignore into schema_migrations(version) values (2);
      insert or ignore into schema_migrations(version) values (3);
    `);
  }
}

function boundLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(limit ?? 50, 200));
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  return values[Math.min(values.length - 1, Math.floor(values.length * p))];
}

export function safePromptHash(request: ChatCompletionRequest): string {
  const safe = JSON.stringify(
    request.messages.map((message) => ({ role: message.role, content: message.content }))
  );
  return createHash("sha256").update(safe).digest("hex");
}
