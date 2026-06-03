# Privacy

TRMNL Token Meter is designed around a narrow collector boundary: raw AI coding session content stays on the local machine.

## Uploaded

The collector uploads only aggregate usage fields accepted by the hosted
TRMNL Token Meter backend aggregate schema:

- Schema version, generated timestamp, machine ID, and machine label
- Total token and estimated cost summaries for today, the last 7 days, the last 14 days, and the last 30 days
- Daily total token and estimated cost buckets needed for trend rendering
- Normalized model total token and estimated cost totals
- Optional provider-level source summaries for enabled Codex, OpenCode, and Claude sources, using the same sanitized aggregate shapes
- Supported providers, locally enabled providers, and provider availability statuses
- Cost status, pricing catalog version, and generic warning codes
- Local source category status only: source kind, enabled flag, status, generic warning code, and record count
- Generic collector warning codes
- Collector version, cost engine version, and whether the Codex home was default or custom

Uploaded usage sections do not include input, output, cache-read, cache-creation, or other token mix fields.

## Local Only Inputs

These inputs remain on the local machine and are normalized before aggregation:

- Active Codex session JSONL under `$CODEX_HOME/sessions`
- Archived Codex session JSONL under `$CODEX_HOME/archived_sessions`
- Normalized OpenCode session columns for model, timestamp, tokens, and stored cost from `~/.local/share/opencode/opencode.db`, or the database selected by `TRMNL_TOKEN_METER_OPENCODE_DB`
- Claude project JSONL under `CLAUDE_CONFIG_DIR/projects`, `~/.config/claude/projects`, or `~/.claude/projects`
- Priority-tier evidence from `$CODEX_HOME/logs_2.sqlite`
- Optional Pi JSONL under `~/.pi/agent/sessions`, only after opt-in

Provider support is separate from provider consent. The CLI can report through a
content-free check that a source appears available without aggregating it. It
reads and uploads usage summaries only for providers enabled for that device by
the backend configuration.

## Never Uploaded

The collector must not upload prompts, responses, tool output, file contents, diffs, shell commands, absolute paths, repository names, priority-tier SQL row details, OpenCode messages, OpenCode parts, OpenCode titles, OpenCode paths, OpenCode directories, OpenCode projects, OpenCode account metadata, Claude transcript content, Pi session contents, auth files, browser cookies, OpenAI API keys, TRMNL secrets, pairing codes, or collector bearer tokens.

Tests include canary prompts, fake secrets, path-like strings, commands, repository-like names, and fake auth material. Serialized uploads and logs must not contain those canary values.

## Backend Storage

The backend stores plugin connection metadata, revocable collector machine records, display preferences, audit events, per-device source state, and latest sanitized usage snapshots. It does not receive or retain raw Codex JSONL records, raw OpenCode SQLite rows or session content, raw Claude project transcripts, or local project content.

Deleting data disables active collectors and removes stored usage snapshots. Uninstalling the TRMNL plugin revokes collectors and marks the plugin connection uninstalled so future uploads fail.

## Future Opt-In Fields

Any future field that could identify local projects, files, commands, or user content must be added behind explicit opt-in and must include schema, collector allowlist, log-redaction, and privacy canary tests before release.
