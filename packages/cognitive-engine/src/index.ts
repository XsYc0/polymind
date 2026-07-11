import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  RoutingPolicy
} from "@polymind/contracts";
import { PolyMindError, routingPolicySchema } from "@polymind/contracts";
import type { ExecutionContext, ExecutionEngine } from "@polymind/execution-engine";
import type { ModelRegistry } from "@polymind/model-registry";
import type { PolyMindRepository } from "@polymind/persistence";

export const taskTypeSchema = z.enum([
  "general-chat",
  "summarization",
  "extraction",
  "classification",
  "translation",
  "coding",
  "debugging",
  "architecture",
  "mathematical-reasoning",
  "research",
  "planning",
  "creative-writing",
  "document-analysis",
  "structured-generation",
  "tool-use",
  "unknown"
]);
export type TaskType = z.infer<typeof taskTypeSchema>;

export const executionModeSchema = z.enum([
  "direct",
  "cascade",
  "specialist",
  "council",
  "workflow",
  "local-only",
  "cached",
  "hybrid"
]);
export type ExecutionMode = z.infer<typeof executionModeSchema>;

export interface TaskProfile {
  taskType: TaskType;
  complexity: "low" | "medium" | "high";
  riskLevel: "low" | "medium" | "high";
  privacySensitivity: "public" | "private" | "local";
  requiredCapabilities: string[];
  estimatedContextSize: number;
  expectedOutputType: "text" | "json" | "code" | "tool-call";
  needsTools: boolean;
  needsVerification: boolean;
  decomposable: boolean;
  expectedLatencyClass: "interactive" | "standard" | "batch";
  expectedCostClass: "low" | "medium" | "high";
  confidence: number;
  explanations: Record<string, string>;
}

export interface ExecutionBudget {
  preset: "economy" | "balanced" | "quality" | "local-only" | "custom";
  maximumEstimatedCost?: number | undefined;
  maximumWallClockMs: number;
  maximumProviderCalls: number;
  maximumExecutionNodes: number;
  maximumParallelCalls: number;
  maximumCouncilParticipants: number;
}

export interface ExecutionPolicy {
  mode: ExecutionMode | "auto";
  budget: ExecutionBudget;
  privacy: "standard" | "private" | "local-only";
  cache: boolean;
  explain: boolean;
  ruflo: "native-only" | "ruflo-preferred-with-native-fallback" | "ruflo-only" | "automatic";
  routingPolicy: RoutingPolicy;
}

export interface ExecutionNode {
  id: string;
  role:
    | "primary"
    | "classifier"
    | "decomposer"
    | "researcher"
    | "coder"
    | "reviewer"
    | "security-reviewer"
    | "critic"
    | "verifier"
    | "judge"
    | "synthesizer"
    | "formatter"
    | "tool-runner"
    | "custom";
  task: string;
  dependencies: string[];
  requiredCapabilities: string[];
  status: "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped";
  maximumCost?: number | undefined;
  maximumLatencyMs?: number | undefined;
  maximumOutputTokens?: number | undefined;
  validationPolicy?: "none" | "json" | "coverage" | "code-block" | undefined;
}

export interface ExecutionEdge {
  from: string;
  to: string;
}

export interface ExecutionPlan {
  id: string;
  mode: ExecutionMode;
  nodes: ExecutionNode[];
  edges: ExecutionEdge[];
  maximumDepth: number;
  maximumParallelism: number;
  explanation: string;
}

export interface EvaluationResult {
  passed: boolean;
  score: number;
  threshold: number;
  reasons: string[];
  detectedDefects: string[];
  repairRecommendation?: string | undefined;
  escalationAllowed: boolean;
}

export interface ConfidenceSignal {
  name: string;
  score: number;
  weight: number;
  reason: string;
}

export interface ExecutionExplanation {
  executionId: string;
  mode: ExecutionMode;
  taskType: TaskType;
  selectedModels: string[];
  decisionReason: string;
  confidence: {
    score: number;
    band: "low" | "medium" | "high";
    signals: ConfidenceSignal[];
    uncertaintyNote: string;
  };
}

export interface CognitiveExecutionResult {
  executionId: string;
  response: ChatCompletionResponse;
  profile: TaskProfile;
  plan: ExecutionPlan;
  evaluations: EvaluationResult[];
  explanation: ExecutionExplanation;
  cache: { hit: boolean; key?: string | undefined };
  budget: { preset: ExecutionBudget["preset"]; providerCalls: number; budgetLimited: boolean };
}

export interface CognitiveEngineOptions {
  registry: ModelRegistry;
  executionEngine: ExecutionEngine;
  repository: PolyMindRepository;
}

export class CognitiveEngine {
  constructor(private readonly options: CognitiveEngineOptions) {}

  async execute(
    request: ChatCompletionRequest,
    inputPolicy: Partial<ExecutionPolicy> | undefined,
    context: ExecutionContext
  ): Promise<CognitiveExecutionResult> {
    const executionId = context.traceId ?? randomUUID();
    const profile = analyzeTask(request, inputPolicy);
    const policy = normalizeExecutionPolicy(inputPolicy, profile);
    const plan = generateExecutionPlan(profile, policy);
    validatePlan(plan);
    enforceBudget(plan, policy.budget);
    await this.options.repository.saveExecutionPlan?.({
      executionId,
      createdAt: new Date().toISOString(),
      mode: plan.mode,
      taskType: profile.taskType,
      status: "running",
      plan,
      profile,
      budget: policy.budget
    });

    const evaluations: EvaluationResult[] = [];
    const selectedModels: string[] = [];
    let response: ChatCompletionResponse | undefined;
    let providerCalls = 0;

    if (plan.mode === "council") {
      const candidates = this.options.registry
        .candidates(policy.routingPolicy)
        .slice(0, policy.budget.maximumCouncilParticipants);
      if (candidates.length === 0)
        throw new PolyMindError("No council candidates", "no_model", 400);
      const responses: ChatCompletionResponse[] = [];
      for (const candidate of candidates) {
        providerCalls += 1;
        selectedModels.push(candidate.id);
        responses.push(
          await this.runDirect(
            request,
            {
              ...policy,
              routingPolicy: {
                ...policy.routingPolicy,
                allowedModels: [candidate.id],
                fallback: false
              }
            },
            context,
            executionId
          )
        );
      }
      response = synthesizeCouncilResponse(request, responses, executionId);
      evaluations.push(evaluateText(response.choices[0]?.message.content ?? "", profile, request));
    } else if (plan.mode === "cascade") {
      response = await this.runCascade(request, policy, context, executionId, selectedModels);
      providerCalls = selectedModels.length;
      evaluations.push(evaluateText(response.choices[0]?.message.content ?? "", profile, request));
    } else {
      response = await this.runDirect(request, policy, context, executionId);
      providerCalls = 1;
      selectedModels.push(response.polymind?.modelId ?? request.model);
      evaluations.push(evaluateText(response.choices[0]?.message.content ?? "", profile, request));
    }

    const confidence = aggregateConfidence(profile, evaluations, providerCalls, plan.mode);
    const explanation: ExecutionExplanation = {
      executionId,
      mode: plan.mode,
      taskType: profile.taskType,
      selectedModels,
      decisionReason: plan.explanation,
      confidence
    };
    await this.options.repository.saveExecutionPlan?.({
      executionId,
      createdAt: new Date().toISOString(),
      mode: plan.mode,
      taskType: profile.taskType,
      status: "succeeded",
      plan,
      profile,
      evaluations,
      explanation,
      budget: policy.budget
    });
    return {
      executionId,
      response: attachExplanation(response, explanation, policy),
      profile,
      plan,
      evaluations,
      explanation,
      cache: { hit: false },
      budget: { preset: policy.budget.preset, providerCalls, budgetLimited: false }
    };
  }

  private async runDirect(
    request: ChatCompletionRequest,
    policy: ExecutionPolicy,
    context: ExecutionContext,
    executionId: string
  ): Promise<ChatCompletionResponse> {
    return this.options.executionEngine.execute(
      { ...request, stream: false },
      policy.routingPolicy,
      { ...context, traceId: executionId }
    );
  }

  private async runCascade(
    request: ChatCompletionRequest,
    policy: ExecutionPolicy,
    context: ExecutionContext,
    executionId: string,
    selectedModels: string[]
  ): Promise<ChatCompletionResponse> {
    const candidates = this.options.registry
      .candidates(policy.routingPolicy)
      .slice(0, policy.budget.maximumProviderCalls);
    let lastError: unknown;
    for (const candidate of candidates) {
      selectedModels.push(candidate.id);
      try {
        const response = await this.runDirect(
          request,
          {
            ...policy,
            routingPolicy: {
              ...policy.routingPolicy,
              allowedModels: [candidate.id],
              fallback: false
            }
          },
          context,
          executionId
        );
        const evaluation = evaluateText(
          response.choices[0]?.message.content ?? "",
          analyzeTask(request, policy),
          request
        );
        if (evaluation.passed || !evaluation.escalationAllowed) return response;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    throw new PolyMindError(
      "Cascade exhausted without response",
      "cascade_exhausted",
      503,
      "provider_unavailable",
      true
    );
  }
}

export function analyzeTask(
  request: ChatCompletionRequest,
  policy?: Partial<ExecutionPolicy>
): TaskProfile {
  const text = request.messages.map((message) => String(message.content)).join("\n");
  const lower = text.toLowerCase();
  const hasCode = /```|function|class |typescript|python|bug|debug|stack trace/.test(lower);
  const wantsJson =
    Boolean(request.response_format) || /json|schema|extract|structured/.test(lower);
  const math = /\b(prove|calculate|equation|integral|probability)\b/.test(lower);
  const research = /\b(research|sources|evidence|cite|latest)\b/.test(lower);
  const architecture = /\b(architecture|design review|scalability|reliability)\b/.test(lower);
  const risky = /\b(secret|credential|security|auth|payment|medical|legal)\b/.test(lower);
  const long = text.length > 4000;
  const taskType: TaskType =
    policy?.mode === "specialist"
      ? "planning"
      : hasCode
        ? lower.includes("debug")
          ? "debugging"
          : "coding"
        : architecture
          ? "architecture"
          : research
            ? "research"
            : math
              ? "mathematical-reasoning"
              : wantsJson
                ? "structured-generation"
                : lower.includes("translate")
                  ? "translation"
                  : lower.includes("summar")
                    ? "summarization"
                    : "general-chat";
  const complexity =
    long || research || architecture ? "high" : hasCode || math || wantsJson ? "medium" : "low";
  const privacySensitivity =
    risky || /private|confidential|internal/.test(lower) ? "private" : "public";
  return {
    taskType,
    complexity,
    riskLevel: risky || research ? "high" : hasCode || math ? "medium" : "low",
    privacySensitivity,
    requiredCapabilities: [
      "chat",
      ...(request.stream ? ["streaming"] : []),
      ...(wantsJson ? ["structured-output"] : []),
      ...(hasCode ? ["coding"] : []),
      ...(request.tools?.length ? ["tool-use"] : [])
    ],
    estimatedContextSize: estimateTokens(text),
    expectedOutputType: wantsJson
      ? "json"
      : hasCode
        ? "code"
        : request.tools?.length
          ? "tool-call"
          : "text",
    needsTools: Boolean(request.tools?.length),
    needsVerification: complexity !== "low" || risky,
    decomposable: complexity === "high" || architecture || research,
    expectedLatencyClass:
      complexity === "low" ? "interactive" : complexity === "medium" ? "standard" : "batch",
    expectedCostClass: complexity === "low" ? "low" : complexity === "medium" ? "medium" : "high",
    confidence: 0.74,
    explanations: {
      taskType: "Derived from deterministic keyword and request-shape inspection.",
      complexity:
        "Estimated from prompt length, task keywords, and structured-output requirements.",
      privacy: "Derived from explicit privacy/security/confidentiality indicators."
    }
  };
}

export function normalizeExecutionPolicy(
  input: Partial<ExecutionPolicy> | undefined,
  profile: TaskProfile
): ExecutionPolicy {
  const preset =
    input?.budget?.preset ?? (profile.privacySensitivity === "local" ? "local-only" : "balanced");
  const budget = budgetPreset(preset, input?.budget);
  const mode = input?.mode && input.mode !== "auto" ? input.mode : chooseMode(profile, budget);
  return {
    mode,
    budget,
    privacy: input?.privacy ?? (profile.privacySensitivity === "local" ? "local-only" : "standard"),
    cache: input?.cache ?? true,
    explain: input?.explain ?? false,
    ruflo: input?.ruflo ?? "automatic",
    routingPolicy: routingPolicySchema.parse({
      strategy: mode === "cascade" ? "fallback-chain" : "balanced",
      fallback: mode !== "direct",
      requiredCapabilities: profile.requiredCapabilities.filter((capability) =>
        ["chat", "streaming", "tool-use", "structured-output"].includes(capability)
      ),
      localOnly: input?.privacy === "local-only" || preset === "local-only",
      ...input?.routingPolicy
    })
  };
}

export function chooseMode(profile: TaskProfile, budget: ExecutionBudget): ExecutionMode {
  if (budget.preset === "local-only" || profile.privacySensitivity === "local") return "local-only";
  if (profile.complexity === "low" && profile.riskLevel === "low") return "direct";
  if (
    profile.taskType === "coding" ||
    profile.taskType === "architecture" ||
    profile.taskType === "structured-generation"
  ) {
    return "specialist";
  }
  if (profile.riskLevel === "high" || profile.taskType === "research") return "council";
  return "cascade";
}

export function generateExecutionPlan(
  profile: TaskProfile,
  policy: ExecutionPolicy
): ExecutionPlan {
  const mode = policy.mode === "auto" ? chooseMode(profile, policy.budget) : policy.mode;
  const nodes: ExecutionNode[] =
    mode === "specialist"
      ? specialistNodes(profile)
      : mode === "council"
        ? councilNodes(policy.budget.maximumCouncilParticipants)
        : mode === "cascade"
          ? [
              node("stage-1", "primary", "Run cheapest eligible model", []),
              node("verifier", "verifier", "Evaluate answer and stop or escalate", ["stage-1"])
            ]
          : [node("primary", "primary", "Answer the user request", [])];
  return {
    id: randomUUID(),
    mode,
    nodes,
    edges: nodes.flatMap((target) => target.dependencies.map((from) => ({ from, to: target.id }))),
    maximumDepth: 6,
    maximumParallelism: policy.budget.maximumParallelCalls,
    explanation: `Selected ${mode} because task is ${profile.complexity} complexity, ${profile.riskLevel} risk, type ${profile.taskType}.`
  };
}

export function validatePlan(plan: ExecutionPlan): void {
  if (plan.nodes.length > 32)
    throw new PolyMindError("Execution plan exceeds node limit", "plan_node_limit", 400);
  const ids = new Set(plan.nodes.map((item) => item.id));
  for (const edge of plan.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to))
      throw new PolyMindError("Execution plan contains invalid edge", "plan_invalid_edge", 400);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(plan.nodes.map((item) => [item.id, item]));
  const visit = (id: string): void => {
    if (visiting.has(id))
      throw new PolyMindError("Execution plan contains a cycle", "plan_cycle", 400);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependencies ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of plan.nodes) visit(item.id);
}

export function evaluateText(
  text: string,
  profile: TaskProfile,
  request: ChatCompletionRequest
): EvaluationResult {
  const reasons: string[] = [];
  const defects: string[] = [];
  if (text.trim()) reasons.push("Response is non-empty");
  else defects.push("Response is empty");
  if (profile.expectedOutputType === "json") {
    try {
      JSON.parse(text);
      reasons.push("Response parses as JSON");
    } catch {
      defects.push("Response does not parse as JSON");
    }
  }
  if (profile.expectedOutputType === "code" && !/```|function|class|const|let|import/.test(text)) {
    defects.push("Expected code-oriented response signals were not found");
  }
  const requiredWords = request.messages
    .filter((message) => message.role === "user")
    .flatMap(
      (message) =>
        String(message.content)
          .toLowerCase()
          .match(/[a-z]{5,}/g) ?? []
    )
    .slice(0, 5);
  const coverage =
    requiredWords.length === 0
      ? 1
      : requiredWords.filter((word) => text.toLowerCase().includes(word)).length /
        requiredWords.length;
  const score = Math.max(
    0,
    Math.min(1, (text.trim() ? 0.5 : 0) + coverage * 0.4 + (defects.length === 0 ? 0.1 : 0))
  );
  return {
    passed: defects.length === 0 && score >= 0.6,
    score,
    threshold: 0.6,
    reasons,
    detectedDefects: defects,
    repairRecommendation: defects.length
      ? "Retry with stricter formatting or stronger eligible model."
      : undefined,
    escalationAllowed: defects.length > 0
  };
}

export function aggregateConfidence(
  profile: TaskProfile,
  evaluations: EvaluationResult[],
  providerCalls: number,
  mode: ExecutionMode
): ExecutionExplanation["confidence"] {
  const signals: ConfidenceSignal[] = [
    {
      name: "task classification",
      score: profile.confidence,
      weight: 0.2,
      reason: "Rule-based classifier confidence."
    },
    {
      name: "validation",
      score: average(evaluations.map((item) => item.score)),
      weight: 0.45,
      reason: "Deterministic evaluation score."
    },
    {
      name: "completion",
      score: evaluations.every((item) => item.passed) ? 0.9 : 0.45,
      weight: 0.25,
      reason: "Validation pass/fail state."
    },
    {
      name: "execution-mode-fit",
      score: mode === "direct" && profile.complexity === "low" ? 0.85 : 0.7,
      weight: 0.1,
      reason: "Heuristic mode/task fit."
    }
  ];
  if (providerCalls > 1)
    signals.push({
      name: "multi-attempt",
      score: 0.72,
      weight: 0.05,
      reason: "Multiple provider/model attempts were observed."
    });
  const totalWeight = signals.reduce((sum, signal) => sum + signal.weight, 0);
  const score =
    signals.reduce((sum, signal) => sum + signal.score * signal.weight, 0) / totalWeight;
  return {
    score: Number(score.toFixed(3)),
    band: score >= 0.8 ? "high" : score >= 0.55 ? "medium" : "low",
    signals,
    uncertaintyNote:
      "Confidence is an aggregation of observable checks, not hidden model certainty."
  };
}

function specialistNodes(profile: TaskProfile): ExecutionNode[] {
  const nodes = [
    node(
      "primary",
      profile.taskType === "coding" ? "coder" : "researcher",
      "Produce primary answer",
      []
    ),
    node("reviewer", "reviewer", "Review correctness and completeness", ["primary"]),
    node("synthesizer", "synthesizer", "Synthesize final response", ["primary", "reviewer"])
  ];
  if (
    profile.riskLevel !== "low" ||
    profile.taskType === "coding" ||
    profile.taskType === "architecture"
  ) {
    nodes.splice(
      2,
      0,
      node("security-reviewer", "security-reviewer", "Review security and operational risk", [
        "primary"
      ])
    );
    nodes[nodes.length - 1]!.dependencies.push("security-reviewer");
  }
  return nodes;
}

function councilNodes(count: number): ExecutionNode[] {
  const participants = Array.from({ length: Math.max(2, Math.min(count, 4)) }, (_, index) =>
    node(`participant-${index + 1}`, "primary", "Produce independent answer", [])
  );
  return [
    ...participants,
    node(
      "judge",
      "judge",
      "Evaluate independent answers",
      participants.map((item) => item.id)
    ),
    node("synthesizer", "synthesizer", "Return final answer", ["judge"])
  ];
}

function node(
  id: string,
  role: ExecutionNode["role"],
  task: string,
  dependencies: string[]
): ExecutionNode {
  return {
    id,
    role,
    task,
    dependencies,
    requiredCapabilities: ["chat"],
    status: dependencies.length ? "pending" : "ready",
    maximumLatencyMs: 30_000,
    validationPolicy: "coverage"
  };
}

function budgetPreset(
  preset: ExecutionBudget["preset"],
  overrides?: Partial<ExecutionBudget>
): ExecutionBudget {
  const base: Record<ExecutionBudget["preset"], ExecutionBudget> = {
    economy: {
      preset,
      maximumEstimatedCost: 0.02,
      maximumWallClockMs: 15_000,
      maximumProviderCalls: 2,
      maximumExecutionNodes: 4,
      maximumParallelCalls: 1,
      maximumCouncilParticipants: 2
    },
    balanced: {
      preset,
      maximumEstimatedCost: 0.1,
      maximumWallClockMs: 30_000,
      maximumProviderCalls: 4,
      maximumExecutionNodes: 8,
      maximumParallelCalls: 2,
      maximumCouncilParticipants: 3
    },
    quality: {
      preset,
      maximumEstimatedCost: 0.5,
      maximumWallClockMs: 60_000,
      maximumProviderCalls: 8,
      maximumExecutionNodes: 16,
      maximumParallelCalls: 3,
      maximumCouncilParticipants: 4
    },
    "local-only": {
      preset,
      maximumEstimatedCost: 0,
      maximumWallClockMs: 30_000,
      maximumProviderCalls: 3,
      maximumExecutionNodes: 6,
      maximumParallelCalls: 1,
      maximumCouncilParticipants: 2
    },
    custom: {
      preset,
      maximumWallClockMs: 30_000,
      maximumProviderCalls: 3,
      maximumExecutionNodes: 8,
      maximumParallelCalls: 2,
      maximumCouncilParticipants: 3
    }
  };
  return { ...base[preset], ...overrides, preset };
}

function enforceBudget(plan: ExecutionPlan, budget: ExecutionBudget): void {
  if (plan.nodes.length > budget.maximumExecutionNodes) {
    throw new PolyMindError(
      "Execution plan exceeds budget node limit",
      "budget_nodes_exceeded",
      400
    );
  }
  if (plan.maximumParallelism > budget.maximumParallelCalls) {
    throw new PolyMindError(
      "Execution plan exceeds parallel budget",
      "budget_parallel_exceeded",
      400
    );
  }
}

function synthesizeCouncilResponse(
  request: ChatCompletionRequest,
  responses: ChatCompletionResponse[],
  executionId: string
): ChatCompletionResponse {
  const content = responses
    .map(
      (response, index) =>
        `Council answer ${index + 1}: ${response.choices[0]?.message.content ?? ""}`
    )
    .join("\n\n");
  return {
    id: `chatcmpl-${executionId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    polymind: responses[0]?.polymind
  };
}

function attachExplanation(
  response: ChatCompletionResponse,
  explanation: ExecutionExplanation,
  policy: ExecutionPolicy
): ChatCompletionResponse {
  if (!policy.explain) return response;
  return {
    ...response,
    polymind: {
      ...response.polymind!,
      executionId: explanation.executionId,
      mode: explanation.mode,
      taskType: explanation.taskType,
      confidence: explanation.confidence,
      decision: { reason: explanation.decisionReason }
    } as ChatCompletionResponse["polymind"] & Record<string, unknown>
  };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}
