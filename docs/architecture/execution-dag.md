# Execution DAG Architecture

Plans are directed acyclic graphs. Nodes declare role, task, dependencies, capabilities, validation policy, and status. Edges are derived from dependencies and cycle-checked before execution.
