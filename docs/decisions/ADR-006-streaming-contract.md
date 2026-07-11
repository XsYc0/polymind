# ADR-006 Streaming Contract

Accepted.

PolyMind provider adapters emit normalized async chunks. The gateway translates those chunks into OpenAI-compatible SSE and writes exactly one `[DONE]` marker at the HTTP boundary. Partial stream failures are not retried into a new visible stream after content has been emitted.
