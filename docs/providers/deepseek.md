# DeepSeek Provider

Status: implemented and deterministic fake-server tested. Live testing is optional and was not run without credentials.

Configure `type: deepseek`, `secretRef: env:DEEPSEEK_API_KEY`, optional `baseUrl`, and model entries with DeepSeek upstream model identifiers. DeepSeek uses the shared OpenAI-style HTTP transport with DeepSeek defaults and its own provider type/capability declaration.

Reasoning deltas are normalized into `reasoning_content` in streaming chunks when returned upstream.
