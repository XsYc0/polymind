import type { PolyMindConfig } from "@polymind/config";
import { defaultConfig } from "@polymind/config";

export function testConfig(overrides: Partial<PolyMindConfig> = {}): PolyMindConfig {
  return {
    ...defaultConfig,
    storage: { ...defaultConfig.storage, sqlitePath: ":memory:", storeRequestContent: false },
    ...overrides
  };
}
