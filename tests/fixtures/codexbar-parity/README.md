# CodexBar Parity Fixtures

These fixtures exercise the local-only scanner inputs used for CodexBar-parity cost
calculation:

- `sessions/`: active Codex JSONL session records
- `archived_sessions/`: archived Codex JSONL records
- `pi/agent/sessions/`: optional Pi JSONL records

The fixture contents intentionally include only synthetic prompts, paths, and usage
counts. Expected totals are asserted in collector and pricing tests.
