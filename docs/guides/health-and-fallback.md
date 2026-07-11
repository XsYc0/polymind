# Health And Fallback

The provider manager tracks runtime state, in-flight counts, recent outcomes, rolling success rate, and a closed/open/half-open circuit breaker.

Circuit behavior:

- `closed`: normal traffic; failures accumulate.
- `open`: ordinary traffic is blocked until cooldown expires.
- `half-open`: one bounded probe is allowed; success closes the circuit and failure reopens it.

The background scheduler runs active health checks, skips disabled providers, avoids overlapping checks for the same provider, and stops during server shutdown. Passive request observations are merged through the same success/failure counters used by active checks.
