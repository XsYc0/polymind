# Streaming Architecture

PolyMind exposes OpenAI-compatible Server-Sent Events from `POST /v1/chat/completions` when
`stream: true` is present.

The provider SDK uses `AsyncIterable<ProviderChatChunk>` as the normalized stream contract. Chunks
can carry assistant role deltas, text deltas, reasoning deltas, tool-call deltas, finish reasons,
usage, provider metadata, and normalized timestamps. Provider failures are raised as typed errors
instead of fake error chunks.

The gateway writes:

- `Content-Type: text/event-stream; charset=utf-8`
- `chat.completion.chunk` objects as `data:` events
- exactly one terminal `data: [DONE]`

Fallback is allowed only before the first chunk is emitted. If a provider fails after partial output,
PolyMind records a partial stream trace and closes the stream without replaying content from another
provider.
