import { createHash } from "node:crypto";
import type { ChatCompletionRequest, ChatCompletionResponse } from "@polymind/contracts";

export interface CacheEntry {
  key: string;
  privacy: string;
  capabilities: string[];
  createdAt: string;
  expiresAt?: string | undefined;
  response: ChatCompletionResponse;
  validationPassed: boolean;
}

export interface CacheStats {
  entries: number;
  hits: number;
  misses: number;
  invalidations: number;
}

export class InMemorySemanticCache {
  private readonly entries = new Map<string, CacheEntry>();
  private hits = 0;
  private misses = 0;
  private invalidations = 0;

  lookup(
    request: ChatCompletionRequest,
    options: { privacy: string; capabilities: string[] }
  ): CacheEntry | undefined {
    const key = cacheKey(request, options);
    const entry = this.entries.get(key);
    if (!entry || !entry.validationPassed || expired(entry)) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return entry;
  }

  store(
    request: ChatCompletionRequest,
    options: { privacy: string; capabilities: string[]; ttlMs?: number | undefined },
    response: ChatCompletionResponse,
    validationPassed: boolean
  ): CacheEntry {
    const key = cacheKey(request, options);
    const entry: CacheEntry = {
      key,
      privacy: options.privacy,
      capabilities: options.capabilities,
      createdAt: new Date().toISOString(),
      expiresAt: options.ttlMs ? new Date(Date.now() + options.ttlMs).toISOString() : undefined,
      response,
      validationPassed
    };
    this.entries.set(key, entry);
    return entry;
  }

  purge(): number {
    const count = this.entries.size;
    this.entries.clear();
    this.invalidations += count;
    return count;
  }

  stats(): CacheStats {
    return {
      entries: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      invalidations: this.invalidations
    };
  }
}

export function cacheKey(
  request: ChatCompletionRequest,
  options: { privacy: string; capabilities: string[] }
): string {
  const normalized = JSON.stringify({
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: normalizeText(String(message.content))
    })),
    responseFormat: request.response_format ?? null,
    privacy: options.privacy,
    capabilities: [...options.capabilities].sort()
  });
  return createHash("sha256").update(normalized).digest("hex");
}

export function deterministicEmbedding(text: string): number[] {
  const normalized = normalizeText(text);
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
  for (const [index, char] of [...normalized].entries()) {
    const bucket = index % buckets.length;
    buckets[bucket] = (buckets[bucket] ?? 0) + char.charCodeAt(0) / 255;
  }
  return buckets.map((value) => Number(value.toFixed(4)));
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function expired(entry: CacheEntry): boolean {
  return Boolean(entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now());
}
