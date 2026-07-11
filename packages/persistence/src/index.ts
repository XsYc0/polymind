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
  close?(): void;
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
  }

  async getTrace(traceId: string): Promise<TraceRecord | undefined> {
    const row = this.db.prepare("select json from traces where trace_id = ?").get(traceId) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as TraceRecord) : undefined;
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
      insert or ignore into schema_migrations(version) values (1);
      insert or ignore into schema_migrations(version) values (2);
    `);
  }
}

export function safePromptHash(request: ChatCompletionRequest): string {
  const safe = JSON.stringify(
    request.messages.map((message) => ({ role: message.role, content: message.content }))
  );
  return createHash("sha256").update(safe).digest("hex");
}
