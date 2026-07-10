# Threat Model Starter

Assets: API keys, endpoint URLs, prompts, responses, traces, routing policy, model metadata, and local database files.

Controls in Task 1:

- Secret references are redacted in config output and logs.
- Prompt content persistence is disabled by default.
- Request body limits and request timeouts are configured in the gateway.
- Provider endpoints are explicit config values with an administrative private-endpoint switch.
- Provider errors are normalized before API serialization.

Open work: authentication for administration, retention policies, OpenTelemetry export hardening, and per-tenant isolation.
