# Ollama Provider

Status: implemented and tested with deterministic integration coverage; live local Ollama tests are optional.

Use `type: ollama` with a local `baseUrl`, usually `http://127.0.0.1:11434`. Models should reference installed Ollama model names through `upstreamModel`.

Ollama remains optional. Default CI does not require a running Ollama daemon.
