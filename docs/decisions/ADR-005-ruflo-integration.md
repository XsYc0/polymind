# ADR-005: Ruflo Integration

Status: reviewed for Task 1 boundary.

Task 1 defines `integrations/ruflo` as a future optional orchestration adapter boundary. PolyMind does not copy Ruflo code or fabricate API calls.

Upstream inspected on 2026-07-10:

- Repository: `https://github.com/ruvnet/ruflo`
- License shown by GitHub: MIT
- Latest release shown by GitHub at review time: `v3.25.6`, Jul 9, 2026
- Public shape observed: agent meta-harness for Claude Code and Codex with specialized agents, swarms, memory, federated communication, and security guardrails

Decision direction: keep council, workflow, and swarm-style execution as extension modes over the PolyMind execution engine rather than making Ruflo core infrastructure.
