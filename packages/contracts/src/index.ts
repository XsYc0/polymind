import { z } from "zod";

export const modelCapabilitySchema = z.enum([
  "chat",
  "reasoning",
  "coding",
  "vision",
  "tool-use",
  "embeddings",
  "long-context",
  "structured-output"
]);
export type ModelCapability = z.infer<typeof modelCapabilitySchema>;

export const privacyClassSchema = z.enum(["public", "private", "local"]);
export type PrivacyClass = z.infer<typeof privacyClassSchema>;

export const providerTypeSchema = z.enum(["mock", "ollama", "openai-compatible", "custom"]);
export type ProviderType = z.infer<typeof providerTypeSchema>;

export const healthConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().positive().default(2000),
    intervalMs: z.number().int().positive().optional()
  })
  .default({ enabled: true, timeoutMs: 2000 });
export type HealthConfig = z.infer<typeof healthConfigSchema>;

export const providerDefinitionSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_.:/-]+$/),
  displayName: z.string().min(1),
  type: providerTypeSchema,
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().default(true),
  secretRef: z.string().min(1).optional(),
  health: healthConfigSchema,
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>;

export const modelDefinitionSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-zA-Z0-9_.:/-]+$/),
  providerId: z.string().min(1),
  upstreamModel: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean().default(true),
  capabilities: z.array(modelCapabilitySchema).min(1),
  contextWindow: z.number().int().positive().optional(),
  maximumOutputTokens: z.number().int().positive().optional(),
  inputCostPerMillionTokens: z.number().nonnegative().optional(),
  outputCostPerMillionTokens: z.number().nonnegative().optional(),
  relativeQuality: z.number().min(0).max(1).default(0.5),
  relativeSpeed: z.number().min(0).max(1).default(0.5),
  privacyClass: privacyClassSchema.default("public"),
  tags: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>;

export const routingStrategySchema = z.enum([
  "direct",
  "lowest-cost",
  "lowest-latency",
  "balanced",
  "local-first",
  "fallback-chain"
]);
export type RoutingStrategy = z.infer<typeof routingStrategySchema>;

export const routingPolicySchema = z.object({
  strategy: routingStrategySchema.default("balanced"),
  allowedProviders: z.array(z.string()).optional(),
  deniedProviders: z.array(z.string()).optional(),
  allowedModels: z.array(z.string()).optional(),
  deniedModels: z.array(z.string()).optional(),
  maximumEstimatedCost: z.number().nonnegative().optional(),
  maximumLatencyMs: z.number().int().positive().optional(),
  privacyRequirement: privacyClassSchema.optional(),
  requiredCapabilities: z.array(modelCapabilitySchema).optional(),
  fallback: z.boolean().default(true),
  localOnly: z.boolean().default(false),
  maxAttempts: z.number().int().positive().max(10).optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

export const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.unknown())]),
  name: z.string().optional(),
  tool_call_id: z.string().optional()
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(chatMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stream: z.boolean().default(false),
  tools: z.array(z.unknown()).optional(),
  response_format: z.unknown().optional(),
  polymind: routingPolicySchema.partial().optional()
});
export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  }>;
  usage?:
    | {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      }
    | undefined;
  polymind?:
    | {
        traceId: string;
        requestId: string;
        selectedVirtualModel: string;
        providerId: string;
        modelId: string;
        upstreamModel: string;
        strategy: RoutingStrategy;
        routingReason: string;
        estimatedCost?: number | undefined;
        latencyMs: number;
        attempts: number;
      }
    | undefined;
}

export type FailureCategory =
  "auth" | "timeout" | "rate_limit" | "provider_unavailable" | "validation" | "unknown";

export class PolyMindError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
    public readonly category: FailureCategory = "unknown",
    public readonly retryable = false
  ) {
    super(message);
  }
}

export function assertNever(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}
