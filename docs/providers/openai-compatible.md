# OpenAI-Compatible Providers

Status: implemented and deterministic fake-server tested.

Use `type: openai-compatible` for self-hosted or third-party APIs that expose `/v1/chat/completions` and `/v1/models` using OpenAI-compatible request and streaming SSE shapes. Configure `baseUrl`, optional `secretRef`, and model entries with `upstreamModel`.

This adapter is intentionally generic. Prefer the dedicated OpenAI, DeepSeek, Anthropic, or Gemini providers when those provider-specific wire formats or errors matter.
