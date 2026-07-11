# Task Analysis

Task analysis is deterministic by default. It inspects messages, response format, tools, prompt length, privacy/risk terms, and capability hints to infer task type, complexity, privacy sensitivity, expected output type, verification need, and required capabilities.

The analyzer does not call a model for trivial classification. User policy can override mode, privacy, cache, budget, and Ruflo behavior.
