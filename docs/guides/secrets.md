# Secrets

PolyMind stores secret references, not secret values. Runtime provider CRUD only supports environment variable references such as `env:OPENAI_API_KEY`.

Never place API keys in provider metadata, model metadata, committed YAML, command logs, benchmark output, or test snapshots. Redaction covers keys named like `secret`, `token`, `apiKey`, `authorization`, and `password`, but redaction is a backstop rather than permission to store secrets.
