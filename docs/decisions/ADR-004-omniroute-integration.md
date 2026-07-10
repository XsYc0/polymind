# ADR-004: OmniRoute Integration

Status: reviewed for Task 1 boundary.

Task 1 defines `integrations/omniroute` as a future optional adapter boundary. PolyMind does not copy OmniRoute code or fabricate API calls.

Upstream inspected on 2026-07-10:

- Repository: `https://github.com/diegosouzapw/OmniRoute`
- License shown by GitHub: MIT
- Latest release shown by GitHub at review time: `v3.8.46`, Jul 7, 2026
- Public shape observed: OpenAI-compatible AI gateway with provider routing, auto-fallback, MCP/A2A, model catalogs, dashboard, and routing strategies

Decision direction: selectively adapt public concepts through PolyMind's own provider, registry, and router contracts rather than making OmniRoute an inseparable core dependency.
