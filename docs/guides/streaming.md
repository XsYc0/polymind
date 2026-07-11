# Streaming Guide

Send a normal OpenAI-style chat completion request with `stream: true`:

```json
{
  "model": "polymind/auto",
  "stream": true,
  "messages": [{ "role": "user", "content": "Explain PolyMind" }]
}
```

The response is an SSE stream. Each event is a JSON `chat.completion.chunk` until the final
`data: [DONE]` marker.

Streaming requires the selected model to advertise the `streaming` capability. PolyMind will route
to another eligible model or return a compatibility error when no streaming-capable model is
available.
