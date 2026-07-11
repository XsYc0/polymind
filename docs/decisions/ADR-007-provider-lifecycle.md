# ADR-007 Provider Lifecycle

Accepted.

Provider file configuration is bootstrap input. Runtime provider mutations are stored in SQLite as the effective overlay and are reloaded on startup. Raw secrets are rejected; only safe references are persisted. Provider manager reloads affected runtime state after successful validation and persistence.
