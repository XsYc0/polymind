import { describe, expect, it } from "vitest";
import { MockProvider } from "@polymind/mock-provider";
import { ProviderManager } from "@polymind/provider-sdk";
import { defaultConfig } from "@polymind/config";

describe("ProviderManager", () => {
  it("tracks enable disable and circuit breaker state", async () => {
    const provider = new MockProvider(defaultConfig.providers[0]!, defaultConfig.models, {
      fail: true
    });
    const manager = new ProviderManager({ circuitBreakerThreshold: 2, cooldownMs: 1000 });
    manager.register(provider);

    expect(manager.status("mock-primary").state).toBe("configured");
    manager.disable("mock-primary");
    expect(manager.status("mock-primary").state).toBe("disabled");
    manager.enable("mock-primary");

    await expect(
      manager.withRequest("mock-primary", (activeProvider) =>
        activeProvider.chat({
          request: {
            model: "polymind/auto",
            messages: [{ role: "user", content: "hello" }],
            stream: false
          },
          model: defaultConfig.models[0]!,
          timeoutMs: 1000,
          traceId: "trace"
        })
      )
    ).rejects.toThrow(/mock/i);

    await expect(
      manager.withRequest("mock-primary", (activeProvider) =>
        activeProvider.chat({
          request: {
            model: "polymind/auto",
            messages: [{ role: "user", content: "hello" }],
            stream: false
          },
          model: defaultConfig.models[0]!,
          timeoutMs: 1000,
          traceId: "trace"
        })
      )
    ).rejects.toThrow(/mock/i);

    expect(manager.status("mock-primary").circuitBreaker).toBe("open");
    expect(manager.status("mock-primary").rollingSuccessRate).toBe(0);
  });
});
