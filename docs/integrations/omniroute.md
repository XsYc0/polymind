# OmniRoute Integration

Status: implemented as optional external HTTP delegation. Deterministic fake delegation paths are supported by configuration; live OmniRoute was not authenticated in this task.

Reviewed on 2026-07-11:

- Upstream repository: `https://github.com/diegosouzapw/OmniRoute`
- Public site/docs advertise an OpenAI-compatible endpoint under `localhost:20128/v1`
- Integration mode used by PolyMind: external HTTP, no vendored code
- Authentication: optional bearer token from `secretRef`
- Streaming: delegated as upstream SSE when available

Modes:

- `native-only`: bypass OmniRoute.
- `omniroute-preferred-with-native-fallback`: try OmniRoute first; if it fails before visible output, run native routing.
- `omniroute-only`: fail if OmniRoute is unavailable.

Loop prevention uses `X-PolyMind-Origin`, `X-PolyMind-Trace-Id`, and `X-PolyMind-Route-Depth`. Delegation is rejected above configured maximum depth or when a request already originated from PolyMind.
