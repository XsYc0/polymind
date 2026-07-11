# Gemini Provider

Status: implemented and deterministic fake-server tested. Live testing is optional and was not run without credentials.

Configure `type: gemini`, `secretRef: env:GEMINI_API_KEY`, optional `baseUrl`, and model entries with Gemini model identifiers. PolyMind uses the Developer API shape for `generateContent` and `streamGenerateContent`, maps system instructions, user/assistant turns, text parts, function declarations passthrough, function-call metadata, structured JSON output requests where supported, usage metadata, and finish reasons.

Blocked or filtered Gemini responses are returned as normalized failures rather than empty successful completions.
