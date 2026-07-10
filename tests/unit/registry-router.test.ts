import { describe, expect, it } from "vitest";
import { mergePolicy } from "@polymind/config";
import { ModelRegistry } from "@polymind/model-registry";
import { RoutingEngine } from "@polymind/router";
import { testConfig } from "@polymind/test-utils";

describe("registry and routing", () => {
  it("filters by capability, privacy, and local-only policy", () => {
    const config = testConfig({
      providers: [
        {
          id: "cloud",
          displayName: "Cloud",
          type: "mock",
          enabled: true,
          health: { enabled: true, timeoutMs: 10 },
          metadata: {}
        },
        {
          id: "local",
          displayName: "Local",
          type: "mock",
          enabled: true,
          health: { enabled: true, timeoutMs: 10 },
          metadata: {}
        }
      ],
      models: [
        {
          id: "cloud/chat",
          providerId: "cloud",
          upstreamModel: "cloud-chat",
          displayName: "Cloud Chat",
          enabled: true,
          capabilities: ["chat"],
          relativeQuality: 0.9,
          relativeSpeed: 0.5,
          privacyClass: "public",
          tags: [],
          metadata: {}
        },
        {
          id: "local/chat",
          providerId: "local",
          upstreamModel: "local-chat",
          displayName: "Local Chat",
          enabled: true,
          capabilities: ["chat", "coding"],
          relativeQuality: 0.6,
          relativeSpeed: 0.7,
          privacyClass: "local",
          tags: [],
          metadata: {}
        }
      ]
    });
    const registry = ModelRegistry.fromConfig(config);
    expect(registry.byCapability("coding").map((model) => model.id)).toEqual(["local/chat"]);
    expect(
      registry.candidates(mergePolicy(config, { localOnly: true })).map((model) => model.id)
    ).toEqual(["local/chat"]);
  });

  it("scores deterministically with stable tie-breaking", () => {
    const config = testConfig();
    const registry = ModelRegistry.fromConfig(config);
    const router = new RoutingEngine();
    const decision = router.route({
      request: {
        model: "polymind/auto",
        messages: [{ role: "user", content: "hello" }],
        stream: false
      },
      policy: mergePolicy(config, { strategy: "balanced" }),
      registry,
      health: new Map([["mock-primary", { healthy: true, latencyMs: 1 }]]),
      traceId: "t",
      requestId: "r"
    });
    expect(decision.candidates[0]?.model.id).toBe("mock/good");
    expect(decision.candidates[0]?.score.total).toBeGreaterThan(0);
  });
});
