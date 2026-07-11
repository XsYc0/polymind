import { PolyMindError, type FailureCategory } from "@polymind/contracts";
import { withTimeout } from "@polymind/provider-sdk";

export interface JsonRequestOptions {
  url: URL;
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof fetch | undefined;
  providerName: string;
}

export interface JsonResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

export async function jsonRequest<T>(options: JsonRequestOptions): Promise<JsonResponse<T>> {
  const response = await rawRequest(options);
  const data = (await response.json().catch(() => {
    throw new PolyMindError(
      `${options.providerName} returned malformed JSON`,
      "provider_malformed_response",
      502,
      "provider_unavailable",
      true
    );
  })) as T;
  return { data, headers: response.headers, status: response.status };
}

export async function rawRequest(options: JsonRequestOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const init: RequestInit = {
    method: options.method ?? "GET",
    headers: compactHeaders({
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers
    }),
    signal: withTimeout(options.timeoutMs, options.signal)
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  const response = await fetchImpl(options.url, init);
  if (!response.ok) throw await normalizeHttpFailure(response, options.providerName);
  return response;
}

export function compactHeaders(
  headers: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => Boolean(entry[1]))
  );
}

export function joinUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base);
}

export function bearer(token?: string): string | undefined {
  return token ? `Bearer ${token}` : undefined;
}

export function apiKeyHeader(token?: string): string | undefined {
  return token;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data) yield data;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = buffer
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* parseNdjson(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield JSON.parse(line);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield JSON.parse(buffer);
  } finally {
    reader.releaseLock();
  }
}

export function normalizeFinishReason(value: unknown) {
  if (value === "max_tokens" || value === "length") return "length";
  if (value === "tool_use" || value === "tool_calls") return "tool_calls";
  if (value === "content_filter" || value === "safety" || value === "SAFETY") {
    return "content_filter";
  }
  if (value === "stop" || value === "end_turn" || value === "STOP") return "stop";
  return null;
}

export function retryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

export async function normalizeHttpFailure(
  response: Response,
  providerName: string
): Promise<PolyMindError> {
  const body = await boundedText(response, 4096);
  const category = categoryFromStatus(response.status, body);
  return new PolyMindError(
    `${providerName} request failed ${response.status}: ${safeBody(body)}`,
    `${providerName.toLowerCase()}_${category}`,
    response.status,
    category,
    category === "rate_limit" || category === "timeout" || category === "provider_unavailable"
  );
}

function categoryFromStatus(status: number, body: string): FailureCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "provider_unavailable";
  if (/quota|rate/i.test(body)) return "rate_limit";
  return "validation";
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}...` : text;
}

function safeBody(body: string): string {
  return body.replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [REDACTED]");
}
