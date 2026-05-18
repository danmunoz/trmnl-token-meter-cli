# Privacy

TRMNL Token Meter is designed around a narrow collector boundary: raw Codex session content stays on the local machine.

## Uploaded

The collector uploads only aggregate usage fields accepted by the hosted
TRMNL Token Meter backend aggregate schema:

- Schema version, generated timestamp, machine ID, and machine label
- Token totals and estimated cost summaries for today, the last 7 days, and the last 30 days
- Daily token and estimated cost buckets needed for trend rendering
- Normalized model token and estimated cost totals
- Cost status, pricing catalog version, and generic warning codes
- Local source category status only: source kind, enabled flag, status, generic warning code, and record count
- Generic collector warning codes
- Collector version, cost engine version, and whether the Codex home was default or custom

## Local Only Inputs

These inputs remain on the local machine and are normalized before aggregation:

- Active Codex session JSONL under `$CODEX_HOME/sessions`
- Archived Codex session JSONL under `$CODEX_HOME/archived_sessions`
- Priority-tier evidence from `$CODEX_HOME/logs_2.sqlite`
- Optional Pi JSONL under `~/.pi/agent/sessions`, only after opt-in

## Never Uploaded

The collector must not upload prompts, responses, tool output, file contents, diffs, shell commands, absolute paths, repository names, priority-tier SQL row details, Pi session contents, auth files, browser cookies, OpenAI API keys, TRMNL secrets, pairing codes, or collector bearer tokens.

Tests include canary prompts, fake secrets, path-like strings, commands, repository-like names, and fake auth material. Serialized uploads and logs must not contain those canary values.

## Backend Storage

The backend stores plugin connection metadata, revocable collector machine records, display preferences, audit events, and latest sanitized usage snapshots. It does not receive or retain raw Codex JSONL records.

Deleting data disables active collectors and removes stored usage snapshots. Uninstalling the TRMNL plugin revokes collectors and marks the plugin connection uninstalled so future uploads fail.

## Future Opt-In Fields

Any future field that could identify local projects, files, commands, or user content must be added behind explicit opt-in and must include schema, collector allowlist, log-redaction, and privacy canary tests before release.
