# Ruflo Integration

Status: optional boundary implemented for status/configuration and workflow policy selection. Deterministic fake/status tests are present. Authenticated or installed Ruflo execution was not live-tested.

Reviewed on 2026-07-11:

- Repository: `https://github.com/ruflo/ruflo`
- Documented interface: CLI/MCP-oriented external workflow orchestration
- Invocation assumption: `npx ruflo@latest` or configured external endpoint
- PolyMind responsibility: task policy, providers, budgets, privacy, traces, final answer
- Ruflo responsibility: optional workflow/agent coordination when explicitly enabled

PolyMind does not pass provider secrets to Ruflo and remains fully functional when Ruflo is disabled or unavailable.
