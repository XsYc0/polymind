# ADR-003: SQLite Persistence

Status: accepted.

Task 1 uses zero-configuration SQLite through Node's built-in `node:sqlite` module plus an in-memory repository for tests. Prompt content is not stored by default; only hashes and execution metadata are persisted.
