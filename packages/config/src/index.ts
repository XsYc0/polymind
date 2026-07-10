import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  modelDefinitionSchema,
  providerDefinitionSchema,
  routingPolicySchema,
  type ModelDefinition,
  type ProviderDefinition,
  type RoutingPolicy
} from "@polymind/contracts";

const balancedWeightsSchema = z
  .object({
    quality: z.number().min(0).default(0.45),
    cost: z.number().min(0).default(0.2),
    latency: z.number().min(0).default(0.2),
    health: z.number().min(0).default(0.1),
    localPreference: z.number().min(0).default(0.05)
  })
  .default({ quality: 0.45, cost: 0.2, latency: 0.2, health: 0.1, localPreference: 0.05 });

export const polymindConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().positive().max(65535).default(8080),
      bodyLimitBytes: z.number().int().positive().default(1_048_576),
      requestTimeoutMs: z.number().int().positive().default(30_000)
    })
    .default({
      host: "127.0.0.1",
      port: 8080,
      bodyLimitBytes: 1_048_576,
      requestTimeoutMs: 30_000
    }),
  logging: z
    .object({
      level: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info")
    })
    .default({ level: "info" }),
  storage: z
    .object({
      sqlitePath: z.string().default(".polymind/polymind.db"),
      storeRequestContent: z.boolean().default(false)
    })
    .default({ sqlitePath: ".polymind/polymind.db", storeRequestContent: false }),
  security: z
    .object({
      allowPrivateEndpoints: z.boolean().default(true)
    })
    .default({ allowPrivateEndpoints: true }),
  routing: z
    .object({
      defaultStrategy: routingPolicySchema.shape.strategy.default("balanced"),
      maxAttempts: z.number().int().positive().max(10).default(3),
      balancedWeights: balancedWeightsSchema
    })
    .default({
      defaultStrategy: "balanced",
      maxAttempts: 3,
      balancedWeights: {
        quality: 0.45,
        cost: 0.2,
        latency: 0.2,
        health: 0.1,
        localPreference: 0.05
      }
    }),
  providers: z.array(providerDefinitionSchema).default([]),
  models: z.array(modelDefinitionSchema).default([])
});
export type PolyMindConfig = z.infer<typeof polymindConfigSchema>;

export const defaultConfig: PolyMindConfig = polymindConfigSchema.parse({
  providers: [
    {
      id: "mock-primary",
      displayName: "Mock Primary",
      type: "mock",
      enabled: true,
      health: { enabled: true, timeoutMs: 1000 }
    }
  ],
  models: [
    {
      id: "mock/good",
      providerId: "mock-primary",
      upstreamModel: "mock-good",
      displayName: "Mock Good",
      enabled: true,
      capabilities: ["chat", "structured-output", "tool-use"],
      relativeQuality: 0.72,
      relativeSpeed: 0.9,
      privacyClass: "public"
    }
  ]
});

export function interpolateEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_match, name: string) => process.env[name] ?? "");
  }
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, interpolateEnv(item)])
    );
  }
  return value;
}

export function redactSecrets<T>(value: T): T {
  const redact = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => {
          if (/secret|token|api[-_]?key|authorization|password/i.test(key))
            return [key, "[REDACTED]"];
          return [key, redact(child)];
        })
      );
    }
    return item;
  };
  return redact(value) as T;
}

export async function loadConfig(configPath?: string): Promise<PolyMindConfig> {
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const resolved = resolve(
    baseDir,
    configPath ?? process.env.POLYMIND_CONFIG ?? "polymind.example.yaml"
  );
  try {
    const raw = await readFile(resolved, "utf8");
    const parsed = YAML.parse(raw, { prettyErrors: true }) as unknown;
    const withEnv = interpolateEnv(parsed);
    const config = polymindConfigSchema.parse(withEnv);
    validateEndpointPolicy(config);
    validateReferences(config.providers, config.models);
    return config;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultConfig;
    }
    throw error;
  }
}

export function validateReferences(
  providers: ProviderDefinition[],
  models: ModelDefinition[]
): void {
  const providerIds = new Set(providers.map((provider) => provider.id));
  const duplicates = findDuplicates([...providers.map((p) => p.id), ...models.map((m) => m.id)]);
  if (duplicates.length > 0)
    throw new Error(`Duplicate provider/model identifiers: ${duplicates.join(", ")}`);
  const invalid = models.filter((model) => !providerIds.has(model.providerId));
  if (invalid.length > 0) {
    throw new Error(
      `Models reference missing providers: ${invalid.map((model) => model.id).join(", ")}`
    );
  }
}

export function validateEndpointPolicy(config: PolyMindConfig): void {
  if (config.security.allowPrivateEndpoints) return;
  for (const provider of config.providers) {
    if (!provider.baseUrl) continue;
    const host = new URL(provider.baseUrl).hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$)/.test(host)) {
      throw new Error(
        `Private endpoint blocked by security.allowPrivateEndpoints=false: ${provider.id}`
      );
    }
  }
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

export async function writeSampleConfig(path: string, force = false): Promise<void> {
  const resolved = resolve(path);
  if (!force) {
    try {
      await access(resolved);
      throw new Error(
        `Refusing to overwrite existing config at ${resolved}. Pass --force to replace it.`
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(dirname(resolved), { recursive: true });
  const sample = YAML.stringify(defaultConfig);
  await writeFile(resolved, sample, "utf8");
}

export function mergePolicy(
  config: PolyMindConfig,
  policy?: Record<string, unknown>
): RoutingPolicy {
  return routingPolicySchema.parse({
    strategy: config.routing.defaultStrategy,
    maxAttempts: config.routing.maxAttempts,
    ...policy
  });
}
