# Provider Management

Task 2 uses a bootstrap-plus-overlay configuration model. YAML config bootstraps providers and models. Runtime mutations through `POST`, `PATCH`, and `DELETE /v1/providers` are persisted to SQLite and become the effective configuration on restart.

Provider CRUD behavior:

- Raw secret values are rejected; use `secretRef: env:NAME`.
- `PATCH` preserves omitted fields and does not erase `secretRef` unless explicitly patched.
- Duplicate provider ids are rejected.
- Deletes that affect referenced models require `cascade=true`.
- Successful changes write provider audit records.
- Rejected changes are validated before persistence.

CLI commands mirror the local admin API: `providers add`, `update`, `remove`, `enable`, `disable`, `health`, and `refresh-models`.
