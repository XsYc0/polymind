# ADR-001: TypeScript Monorepo

Status: accepted.

PolyMind uses pnpm workspaces with strict TypeScript project references. This keeps provider adapters, routing, persistence, and apps independently testable while avoiding premature service decomposition.
