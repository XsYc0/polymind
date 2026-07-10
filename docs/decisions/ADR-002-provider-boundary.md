# ADR-002: Provider Boundary

Status: accepted.

Provider implementations conform to `@polymind/provider-sdk`. Core execution logic depends on the interface, not vendor clients. This allows Ollama, OpenAI-compatible endpoints, and future self-hosted runtimes to evolve independently.
