import { describe, expect, it } from "vitest";
import { constructNodeContext } from "@polymind/context-engine";
import { cacheKey, deterministicEmbedding, InMemorySemanticCache } from "@polymind/semantic-cache";

describe("context engine and semantic cache", () => {
  it("trims node-specific context while preserving system messages", () => {
    const result = constructNodeContext(
      [
        { role: "system", content: "Keep rules" },
        { role: "user", content: "irrelevant chat ".repeat(200) },
        { role: "user", content: "security token auth config risk" }
      ],
      { maxTokens: 80, role: "security-reviewer" }
    );

    expect(result.messages[0]?.role).toBe("system");
    expect(result.finalEstimatedTokens).toBeLessThanOrEqual(80);
    expect(result.methods.length).toBeGreaterThan(0);
  });

  it("partitions exact cache by privacy and capabilities", () => {
    const request = {
      model: "polymind/auto",
      messages: [{ role: "user" as const, content: "cache me" }],
      stream: false
    };
    const publicKey = cacheKey(request, { privacy: "public", capabilities: ["chat"] });
    const privateKey = cacheKey(request, { privacy: "private", capabilities: ["chat"] });
    expect(publicKey).not.toBe(privateKey);

    const cache = new InMemorySemanticCache();
    const miss = cache.lookup(request, { privacy: "public", capabilities: ["chat"] });
    expect(miss).toBeUndefined();
    cache.store(
      request,
      { privacy: "public", capabilities: ["chat"], ttlMs: 1000 },
      {
        id: "chatcmpl-cache",
        object: "chat.completion",
        created: 1,
        model: "polymind/auto",
        choices: [
          { index: 0, message: { role: "assistant", content: "cached" }, finish_reason: "stop" }
        ]
      },
      true
    );
    expect(
      cache.lookup(request, { privacy: "public", capabilities: ["chat"] })?.response.choices[0]
        ?.message.content
    ).toBe("cached");
    expect(deterministicEmbedding("same")).toEqual(deterministicEmbedding("same"));
  });
});
