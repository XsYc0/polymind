import type {
  ModelCapability,
  ModelDefinition,
  ProviderDefinition,
  RoutingPolicy
} from "@polymind/contracts";
import type { PolyMindConfig } from "@polymind/config";
import { redactSecrets, validateReferences } from "@polymind/config";

export class ModelRegistry {
  private readonly providers = new Map<string, ProviderDefinition>();
  private readonly models = new Map<string, ModelDefinition>();

  static fromConfig(config: PolyMindConfig): ModelRegistry {
    const registry = new ModelRegistry();
    for (const provider of config.providers) registry.registerProvider(provider);
    for (const model of config.models) registry.registerModel(model);
    registry.validate();
    return registry;
  }

  registerProvider(provider: ProviderDefinition): void {
    if (this.providers.has(provider.id) || this.models.has(provider.id))
      throw new Error(`Duplicate id: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  upsertProvider(provider: ProviderDefinition): void {
    if (this.models.has(provider.id)) throw new Error(`Duplicate id: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  registerModel(model: ModelDefinition): void {
    if (this.models.has(model.id) || this.providers.has(model.id))
      throw new Error(`Duplicate id: ${model.id}`);
    if (!this.providers.has(model.providerId))
      throw new Error(`Model ${model.id} references unknown provider ${model.providerId}`);
    this.models.set(model.id, model);
  }

  upsertModel(model: ModelDefinition): void {
    if (this.providers.has(model.id)) throw new Error(`Duplicate id: ${model.id}`);
    if (!this.providers.has(model.providerId))
      throw new Error(`Model ${model.id} references unknown provider ${model.providerId}`);
    this.models.set(model.id, model);
  }

  deleteProvider(providerId: string, cascade = false): void {
    const referencedModels = [...this.models.values()].filter(
      (model) => model.providerId === providerId
    );
    if (referencedModels.length > 0 && !cascade) {
      throw new Error(
        `Provider ${providerId} is referenced by models: ${referencedModels.map((model) => model.id).join(", ")}`
      );
    }
    for (const model of referencedModels) this.models.delete(model.id);
    this.providers.delete(providerId);
  }

  setProviderEnabled(providerId: string, enabled: boolean): void {
    const provider = this.requireProvider(providerId);
    this.providers.set(providerId, { ...provider, enabled });
  }

  setModelEnabled(modelId: string, enabled: boolean): void {
    const model = this.requireModel(modelId);
    this.models.set(modelId, { ...model, enabled });
  }

  listProviders(): ProviderDefinition[] {
    return [...this.providers.values()].map((provider) => redactSecrets(provider));
  }

  listModels(): ModelDefinition[] {
    return [...this.models.values()].map((model) => redactSecrets(model));
  }

  provider(id: string): ProviderDefinition | undefined {
    const provider = this.providers.get(id);
    return provider ? redactSecrets(provider) : undefined;
  }

  model(id: string): ModelDefinition | undefined {
    const model = this.models.get(id);
    return model ? redactSecrets(model) : undefined;
  }

  modelsByProvider(providerId: string): ModelDefinition[] {
    return this.listModels().filter((model) => model.providerId === providerId);
  }

  byCapability(capability: ModelCapability): ModelDefinition[] {
    return this.listModels().filter((model) => model.capabilities.includes(capability));
  }

  localOnly(): ModelDefinition[] {
    return this.listModels().filter((model) => model.privacyClass === "local");
  }

  candidates(policy: RoutingPolicy): ModelDefinition[] {
    return this.listModels().filter((model) => this.matchesPolicy(model, policy));
  }

  providerFor(model: ModelDefinition): ProviderDefinition {
    return this.requireProvider(model.providerId);
  }

  validate(): void {
    validateReferences([...this.providers.values()], [...this.models.values()]);
  }

  private matchesPolicy(model: ModelDefinition, policy: RoutingPolicy): boolean {
    const provider = this.providers.get(model.providerId);
    if (!provider?.enabled || !model.enabled) return false;
    if (policy.localOnly && model.privacyClass !== "local") return false;
    if (policy.allowedProviders && !policy.allowedProviders.includes(model.providerId))
      return false;
    if (policy.deniedProviders?.includes(model.providerId)) return false;
    if (policy.allowedModels && !policy.allowedModels.includes(model.id)) return false;
    if (policy.deniedModels?.includes(model.id)) return false;
    if (
      policy.privacyRequirement &&
      privacyRank(model.privacyClass) < privacyRank(policy.privacyRequirement)
    )
      return false;
    if (policy.requiredCapabilities?.some((capability) => !model.capabilities.includes(capability)))
      return false;
    if (
      policy.maximumEstimatedCost !== undefined &&
      estimateConfiguredCost(model, 1000, 1000) > policy.maximumEstimatedCost
    ) {
      return false;
    }
    return true;
  }

  private requireProvider(id: string): ProviderDefinition {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  private requireModel(id: string): ModelDefinition {
    const model = this.models.get(id);
    if (!model) throw new Error(`Unknown model: ${id}`);
    return model;
  }
}

export function privacyRank(value: ModelDefinition["privacyClass"]): number {
  return value === "local" ? 3 : value === "private" ? 2 : 1;
}

export function estimateConfiguredCost(
  model: ModelDefinition,
  promptTokens: number,
  completionTokens: number
): number {
  const input = ((model.inputCostPerMillionTokens ?? 0) * promptTokens) / 1_000_000;
  const output = ((model.outputCostPerMillionTokens ?? 0) * completionTokens) / 1_000_000;
  return Number((input + output).toFixed(8));
}
