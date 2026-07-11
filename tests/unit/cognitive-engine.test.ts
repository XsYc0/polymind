import { describe, expect, it } from "vitest";
import {
  aggregateConfidence,
  analyzeTask,
  generateExecutionPlan,
  normalizeExecutionPolicy,
  validatePlan
} from "@polymind/cognitive-engine";

describe("cognitive engine deterministic planning", () => {
  it("classifies routine prompts as low-risk direct candidates", () => {
    const profile = analyzeTask({
      model: "polymind/auto",
      messages: [{ role: "user", content: "Say hello in one sentence" }],
      stream: false
    });
    const policy = normalizeExecutionPolicy(undefined, profile);
    const plan = generateExecutionPlan(profile, policy);

    expect(profile.taskType).toBe("general-chat");
    expect(profile.complexity).toBe("low");
    expect(policy.mode).toBe("direct");
    expect(plan.nodes).toHaveLength(1);
  });

  it("selects specialist mode for code and adds security review", () => {
    const profile = analyzeTask({
      model: "polymind/specialist",
      messages: [{ role: "user", content: "Review this TypeScript auth function for bugs" }],
      stream: false
    });
    const policy = normalizeExecutionPolicy({ mode: "specialist" }, profile);
    const plan = generateExecutionPlan(profile, policy);

    expect(plan.mode).toBe("specialist");
    expect(plan.nodes.some((node) => node.role === "security-reviewer")).toBe(true);
  });

  it("limits council participants through budget", () => {
    const profile = analyzeTask({
      model: "polymind/council",
      messages: [{ role: "user", content: "Research conflicting evidence and decide" }],
      stream: false
    });
    const policy = normalizeExecutionPolicy(
      {
        mode: "council",
        budget: {
          preset: "balanced",
          maximumWallClockMs: 30_000,
          maximumProviderCalls: 4,
          maximumExecutionNodes: 8,
          maximumParallelCalls: 2,
          maximumCouncilParticipants: 2
        }
      },
      profile
    );
    const plan = generateExecutionPlan(profile, policy);

    expect(plan.nodes.filter((node) => node.id.startsWith("participant-"))).toHaveLength(2);
  });

  it("detects DAG cycles", () => {
    expect(() =>
      validatePlan({
        id: "cycle",
        mode: "workflow",
        maximumDepth: 4,
        maximumParallelism: 1,
        explanation: "cycle",
        nodes: [
          {
            id: "a",
            role: "primary",
            task: "a",
            dependencies: ["b"],
            requiredCapabilities: ["chat"],
            status: "pending"
          },
          {
            id: "b",
            role: "primary",
            task: "b",
            dependencies: ["a"],
            requiredCapabilities: ["chat"],
            status: "pending"
          }
        ],
        edges: [
          { from: "a", to: "b" },
          { from: "b", to: "a" }
        ]
      })
    ).toThrow(/cycle/i);
  });

  it("aggregates confidence from observable signals", () => {
    const profile = analyzeTask({
      model: "polymind/auto",
      messages: [{ role: "user", content: "Summarize this" }],
      stream: false
    });
    const confidence = aggregateConfidence(
      profile,
      [
        {
          passed: true,
          score: 0.9,
          threshold: 0.6,
          reasons: ["ok"],
          detectedDefects: [],
          escalationAllowed: false
        }
      ],
      1,
      "direct"
    );
    expect(confidence.score).toBeGreaterThan(0.7);
    expect(confidence.uncertaintyNote).toContain("observable");
  });
});
