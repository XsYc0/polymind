# Cognitive Engine Architecture

The cognitive engine is a Fastify-independent package. The gateway constructs it with the model registry, execution engine, and persistence repository. It returns a normalized result containing response, profile, plan, evaluations, explanation, cache metadata, and budget summary.
