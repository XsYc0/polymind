# Execution Flow

1. Gateway validates the OpenAI-compatible request.
2. Config defaults and request `polymind` policy are merged.
3. Execution engine obtains provider health.
4. Router filters and scores candidates.
5. Execution engine calls the selected provider.
6. Retryable failures fall back to the next candidate within `maxAttempts`.
7. The final response and safe trace metadata are persisted.
