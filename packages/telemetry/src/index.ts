import type { FailureCategory, TokenUsage } from "@polymind/contracts";

export type TelemetryEventName =
  | "request.received"
  | "routing.started"
  | "routing.candidates_evaluated"
  | "routing.model_selected"
  | "provider.attempt_started"
  | "provider.attempt_succeeded"
  | "provider.attempt_failed"
  | "fallback.triggered"
  | "request.completed";

export interface TelemetryEvent {
  name: TelemetryEventName;
  timestamp: string;
  traceId: string;
  requestId?: string | undefined;
  providerId?: string | undefined;
  modelId?: string | undefined;
  strategy?: string | undefined;
  latencyMs?: number | undefined;
  usage?: TokenUsage | undefined;
  estimatedCost?: number | undefined;
  failureCategory?: FailureCategory | undefined;
  retryCount?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface TelemetrySink {
  emit(event: TelemetryEvent): void | Promise<void>;
}

export class InMemoryTelemetrySink implements TelemetrySink {
  readonly events: TelemetryEvent[] = [];
  emit(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

export function event(
  name: TelemetryEventName,
  data: Omit<TelemetryEvent, "name" | "timestamp">
): TelemetryEvent {
  return { name, timestamp: new Date().toISOString(), ...data };
}
