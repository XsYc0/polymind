# Self-Hosted Clusters

Self-hosted OpenAI-compatible clusters should use `type: openai-compatible` with a private `baseUrl` and explicit model entries. PolyMind does not discover arbitrary network services and does not accept private endpoints when `security.allowPrivateEndpoints` is false.

Recommended settings:

- Use `secretRef: env:NAME` instead of raw tokens.
- Set realistic `health.timeoutMs`.
- Declare only capabilities the upstream actually supports.
- Keep model ids stable and use `upstreamModel` for provider-native names.
