import type { ChatMessage } from "@polymind/contracts";

export interface ContextCompressionResult {
  messages: ChatMessage[];
  originalEstimatedTokens: number;
  finalEstimatedTokens: number;
  reduction: number;
  methods: string[];
}

export function constructNodeContext(
  messages: ChatMessage[],
  options: { maxTokens: number; role?: string }
): ContextCompressionResult {
  const originalEstimatedTokens = estimateMessages(messages);
  const system = messages.filter((message) => message.role === "system");
  const tail = messages.filter((message) => message.role !== "system").slice(-8);
  const filtered =
    options.role === "security-reviewer"
      ? tail.filter((message) =>
          /security|auth|token|secret|risk|code|config/i.test(String(message.content))
        )
      : tail;
  let result = [...system, ...filtered];
  const methods = ["system-preservation", "recent-context-window"];
  while (estimateMessages(result) > options.maxTokens && result.length > system.length + 1) {
    result.splice(system.length, 1);
    methods.push("oldest-message-trim");
  }
  if (estimateMessages(result) > options.maxTokens) {
    result = summarizeMessages(result, options.maxTokens);
    methods.push("summary-compaction");
  }
  const finalEstimatedTokens = estimateMessages(result);
  return {
    messages: result,
    originalEstimatedTokens,
    finalEstimatedTokens,
    reduction: Math.max(0, originalEstimatedTokens - finalEstimatedTokens),
    methods: [...new Set(methods)]
  };
}

export function estimateMessages(messages: ChatMessage[]): number {
  return messages.reduce(
    (sum, message) => sum + Math.max(1, Math.ceil(String(message.content).length / 4)),
    0
  );
}

function summarizeMessages(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  const content = messages
    .map((message) => `${message.role}: ${String(message.content).slice(0, 240)}`)
    .join("\n")
    .slice(0, maxTokens * 4);
  return [{ role: "system", content: `Compressed prior context:\n${content}` }];
}
