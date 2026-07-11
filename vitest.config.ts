import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@polymind/config": resolve(__dirname, "packages/config/src/index.ts"),
      "@polymind/contracts": resolve(__dirname, "packages/contracts/src/index.ts"),
      "@polymind/cloud-providers": resolve(__dirname, "integrations/cloud-providers/src/index.ts"),
      "@polymind/cognitive-engine": resolve(__dirname, "packages/cognitive-engine/src/index.ts"),
      "@polymind/context-engine": resolve(__dirname, "packages/context-engine/src/index.ts"),
      "@polymind/execution-engine": resolve(__dirname, "packages/execution-engine/src/index.ts"),
      "@polymind/gateway/app": resolve(__dirname, "apps/gateway/src/app.ts"),
      "@polymind/model-registry": resolve(__dirname, "packages/model-registry/src/index.ts"),
      "@polymind/mock-provider": resolve(__dirname, "integrations/mock-provider/src/index.ts"),
      "@polymind/ollama": resolve(__dirname, "integrations/ollama/src/index.ts"),
      "@polymind/openai-compatible": resolve(
        __dirname,
        "integrations/openai-compatible/src/index.ts"
      ),
      "@polymind/persistence": resolve(__dirname, "packages/persistence/src/index.ts"),
      "@polymind/provider-sdk": resolve(__dirname, "packages/provider-sdk/src/index.ts"),
      "@polymind/router": resolve(__dirname, "packages/router/src/index.ts"),
      "@polymind/semantic-cache": resolve(__dirname, "packages/semantic-cache/src/index.ts"),
      "@polymind/telemetry": resolve(__dirname, "packages/telemetry/src/index.ts"),
      "@polymind/test-utils": resolve(__dirname, "packages/test-utils/src/index.ts")
    }
  },
  test: {
    globals: true,
    environment: "node",
    testTimeout: 15000,
    coverage: {
      reporter: ["text", "json-summary"],
      include: ["packages/**/*.ts", "integrations/**/*.ts", "apps/**/*.ts"]
    }
  }
});
