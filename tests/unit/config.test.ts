import { describe, expect, it } from "vitest";
import { polymindConfigSchema, redactSecrets, validateEndpointPolicy } from "@polymind/config";

describe("config", () => {
  it("validates sample configuration and redacts secrets", () => {
    const config = polymindConfigSchema.parse({
      providers: [
        {
          id: "p",
          displayName: "P",
          type: "openai-compatible",
          enabled: true,
          secretRef: "env:KEY"
        }
      ],
      models: [
        {
          id: "m",
          providerId: "p",
          upstreamModel: "m",
          displayName: "M",
          capabilities: ["chat"],
          privacyClass: "public"
        }
      ]
    });
    expect(config.providers[0]?.secretRef).toBe("env:KEY");
    expect(redactSecrets(config).providers[0]?.secretRef).toBe("[REDACTED]");
  });

  it("blocks private endpoints when administrative opt-in is disabled", () => {
    expect(() =>
      validateEndpointPolicy(
        polymindConfigSchema.parse({
          security: { allowPrivateEndpoints: false },
          providers: [
            {
              id: "local",
              displayName: "Local",
              type: "ollama",
              baseUrl: "http://127.0.0.1:11434",
              enabled: true
            }
          ]
        })
      )
    ).toThrow(/Private endpoint blocked/);
  });
});
