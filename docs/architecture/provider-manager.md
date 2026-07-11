# Provider Manager

The provider manager wraps provider SDK implementations with runtime state:

- configured, ready, degraded, unhealthy, disabled, and shutting-down style states
- enable and disable controls
- in-flight request counts and configurable concurrency limits
- rolling success rate and consecutive failure tracking
- a closed/open/half-open circuit-breaker state model
- manual health checks

The current implementation is in-process and deterministic for local tests. It does not yet include
a distributed rate limiter or a background health scheduler.
