import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "@polymind/gateway/app";
import { testConfig } from "@polymind/test-utils";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("provider CRUD persistence", () => {
  it("creates, patches, rejects raw secrets, cascades, and reloads persisted providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polymind-crud-"));
    tempDirs.push(dir);
    const sqlitePath = join(dir, "polymind.db");
    const config = testConfig({ storage: { sqlitePath, storeRequestContent: false } });
    const { app } = await buildApp(config);

    const create = await app.inject({
      method: "POST",
      url: "/v1/providers",
      remoteAddress: "127.0.0.1",
      payload: {
        provider: {
          id: "mock-runtime",
          displayName: "Runtime Mock",
          type: "mock",
          enabled: true,
          health: { enabled: true, timeoutMs: 1000 },
          metadata: {}
        },
        models: [
          {
            id: "mock/runtime",
            providerId: "mock-runtime",
            upstreamModel: "mock-runtime",
            displayName: "Runtime",
            enabled: true,
            capabilities: ["chat", "streaming"],
            relativeQuality: 0.5,
            relativeSpeed: 0.5,
            privacyClass: "public",
            tags: [],
            metadata: {}
          }
        ]
      }
    });
    expect(create.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: "POST",
      url: "/v1/providers",
      remoteAddress: "127.0.0.1",
      payload: JSON.parse(create.body)
    });
    expect(duplicate.statusCode).toBe(409);

    const rawSecret = await app.inject({
      method: "PATCH",
      url: "/v1/providers/mock-runtime",
      remoteAddress: "127.0.0.1",
      payload: { provider: { metadata: { apiKey: "do-not-store" } } }
    });
    expect(rawSecret.statusCode).toBe(400);

    const patch = await app.inject({
      method: "PATCH",
      url: "/v1/providers/mock-runtime",
      remoteAddress: "127.0.0.1",
      payload: { provider: { displayName: "Updated Runtime Mock" } }
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body).provider.displayName).toBe("Updated Runtime Mock");

    const deleteBlocked = await app.inject({
      method: "DELETE",
      url: "/v1/providers/mock-runtime",
      remoteAddress: "127.0.0.1"
    });
    expect(deleteBlocked.statusCode).toBe(409);

    await app.close();
    const restarted = await buildApp(config);
    const persisted = await restarted.app.inject({
      method: "GET",
      url: "/v1/providers/mock-runtime"
    });
    expect(persisted.statusCode).toBe(200);
    expect(JSON.parse(persisted.body).displayName).toBe("Updated Runtime Mock");
    await restarted.app.close();
  });
});
