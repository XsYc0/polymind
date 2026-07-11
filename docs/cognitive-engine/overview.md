# Cognitive Engine Overview

Status: implemented with deterministic tests. Authenticated live provider validation was not run.

The cognitive engine coordinates task analysis, execution-mode selection, DAG planning, budget enforcement, evaluation, confidence aggregation, execution trace persistence, and final OpenAI-compatible response shaping. It runs without Ruflo, OmniRoute, paid APIs, Redis, GPUs, or external network access.

Implemented modes: direct, cascade, specialist, council, local-only, workflow-shaped planning, cached metadata paths, and hybrid-compatible policy contracts.
