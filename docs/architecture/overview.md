# Architecture Overview

PolyMind uses a TypeScript-first monorepo. Core packages do not import Fastify. The gateway composes config, registry, providers, router, execution engine, persistence, and telemetry through explicit factories.

Dependency direction is contracts -> infrastructure interfaces -> domain services -> apps.
