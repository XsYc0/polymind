# OpenAI Provider

Status: implemented and deterministic fake-server tested. Live testing is optional and was not run without credentials.

Configure `type: openai`, an `env:` `secretRef`, optional `baseUrl`, and model entries whose `upstreamModel` is the OpenAI model id. Supported behavior includes chat completions, streaming SSE, tool definitions and tool-call deltas, structured response format passthrough, usage normalization, finish-reason normalization, organization/project headers, custom safe headers from metadata, timeout, cancellation, and HTTP error classification.

Secrets must be referenced as environment variables such as `env:OPENAI_API_KEY`; raw API key values are rejected by runtime provider CRUD.
