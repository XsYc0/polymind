# Anthropic Provider

Status: implemented and deterministic fake-server tested. Live testing is optional and was not run without credentials.

Configure `type: anthropic`, `secretRef: env:ANTHROPIC_API_KEY`, optional `baseUrl`, and model entries with Anthropic upstream model identifiers. PolyMind translates system messages into Anthropic `system`, maps user and assistant turns into Messages API format, normalizes text blocks, tool-use blocks, streaming content deltas, usage, and stop reasons.

The default API version is `2023-06-01` and may be overridden with provider metadata `apiVersion`.
