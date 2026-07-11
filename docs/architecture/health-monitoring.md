# Health Monitoring

PolyMind combines active health checks with passive request outcomes.

Implemented locally:

- `GET /v1/providers/:providerId/health`
- `POST /v1/providers/:providerId/health/check`
- provider runtime status in `GET /v1/providers/:providerId`
- circuit opening after repeated provider failures
- migration tables for health history and circuit transitions

The persistence tables are present for Task 2 telemetry, but high-volume retention policies and a
background scheduler still need a later hardening pass.
