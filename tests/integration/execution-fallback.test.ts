import { describe, expect, it } from "vitest";
import { mergePolicy } from "@polymind/config";
import { ExecutionEngine } from "@polymind/execution-engine";
import { ModelRegistry } from "@polymind/model-registry";
import { MockProvider } from "@polymind/mock-provider";
import { InMemoryRepository } from "@polymind/persistence";
import { ProviderManager } from "@polymind/provider-sdk";
import { RoutingEngine } from "@polymind/router";
import { testConfig } from "@polymind/test-utils";

describe("execution fallback", () => {
  it("falls back after retryable provider failure", async () => {
    const config = testConfig({
      providers: [
        {
          id: "bad",
          displayName: "Bad",
          type: "mock",
          enabled: true,
          health: { enabled: true, timeoutMs: 10 },
          metadata: {}
        },
        {
          id: "good",
          displayName: "Good",
          type: "mock",
          enabled: true,
          health: { enabled: true, timeoutMs: 10 },
          metadata: {}
        }
      ],
      models: [
        {
          id: "bad/model",
          providerId: "bad",
          upstreamModel: "bad",
          displayName: "Bad",
          enabled: true,
          capabilities: ["chat"],
          relativeQuality: 0.9,
          relativeSpeed: 0.9,
          privacyClass: "public",
          tags: [],
          metadata: {}
        },
        {
          id: "good/model",
          providerId: "good",
          upstreamModel: "good",
          displayName: "Good",
          enabled: true,
          capabilities: ["chat"],
          relativeQuality: 0.8,
          relativeSpeed: 0.8,
          privacyClass: "public",
          tags: [],
          metadata: {}
        }
      ]
    });
    const registry = ModelRegistry.fromConfig(config);
    const manager = new ProviderManager();
    manager.register(new MockProvider(config.providers[0]!, [config.models[0]!], { fail: true }));
    manager.register(
      new MockProvider(config.providers[1]!, [config.models[1]!], { response: "fallback ok" })
    );
    const repository = new InMemoryRepository();
    const engine = new ExecutionEngine(registry, new RoutingEngine(), manager, repository);
    const response = await engine.execute(
      { model: "polymind/auto", messages: [{ role: "user", content: "hello" }], stream: false },
      mergePolicy(config, { strategy: "balanced", fallback: true }),
      { timeoutMs: 100, storeRequestContent: false }
    );
    expect(response.choices[0]?.message.content).toBe("fallback ok");
    expect(response.polymind?.attempts).toBe(2);
  });
});
