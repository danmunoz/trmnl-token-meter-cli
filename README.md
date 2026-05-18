# TRMNL Token Meter CLI

TRMNL Token Meter is a local collector for showing Codex token usage on a TRMNL display.

The CLI runs on your computer, reads local Codex usage records, calculates aggregate token and estimated cost totals, and syncs those totals to your TRMNL Token Meter plugin. It is meant for people who want a private, glanceable meter for how much Codex usage is happening today, this week, and this month.

Privacy is the core design constraint: raw Codex usage content stays on your machine. The CLI does not upload prompts, responses, commands, diffs, file contents, repository names, or file paths. It sends only aggregate totals and status fields needed to render the TRMNL display.

## Quick Start

1. Install the TRMNL Token Meter plugin in TRMNL.
2. Open the plugin management page and generate a pairing code.
3. Run the CLI on the computer you want to track:

```bash
npx trmnl-token-meter
```

4. Enter the pairing code, choose a machine name, and use this backend URL when prompted:

```text
https://trmnl-token-meter-backend.trmnltkn.workers.dev
```

Setup pairs this machine, uploads the first sanitized aggregate snapshot, and installs background sync. After setup, uploads continue automatically on the configured interval.

## What Gets Sent

Each upload sends a sanitized aggregate snapshot. The CLI computes this locally before upload. Individual usage records are not sent; only aggregate data, totals, and generic status fields are sent.

Compact representative example:

```json
{
  "schema_version": "2026-05-15.v2-codexbar-cost",
  "machine_id": "mach_abc123",
  "machine_label": "My MacBook",
  "generated_at": "2026-05-18T12:42:57.320Z",
  "periods": {
    "today": {
      "start": "2026-05-18",
      "end": "2026-05-19",
      "input_tokens": 120000,
      "cached_input_tokens": 30000,
      "output_tokens": 42000,
      "total_tokens": 162000,
      "estimated_cost_usd": 1.2345,
      "cost_status": "known",
      "pricing_catalog_version": "2026-05-15.codexbar-parity",
      "warning_codes": []
    },
    "last_7_days": {
      "start": "2026-05-12",
      "end": "2026-05-19",
      "input_tokens": 500000,
      "cached_input_tokens": 130000,
      "output_tokens": 180000,
      "total_tokens": 680000,
      "estimated_cost_usd": 5.4321,
      "cost_status": "known",
      "pricing_catalog_version": "2026-05-15.codexbar-parity",
      "warning_codes": []
    },
    "last_30_days": {
      "start": "2026-04-19",
      "end": "2026-05-19",
      "input_tokens": 1500000,
      "cached_input_tokens": 410000,
      "output_tokens": 620000,
      "total_tokens": 2120000,
      "estimated_cost_usd": 16.789,
      "cost_status": "known",
      "pricing_catalog_version": "2026-05-15.codexbar-parity",
      "warning_codes": []
    }
  },
  "daily": [
    {
      "date": "2026-05-18",
      "start": "2026-05-18",
      "end": "2026-05-19",
      "input_tokens": 120000,
      "cached_input_tokens": 30000,
      "output_tokens": 42000,
      "total_tokens": 162000,
      "estimated_cost_usd": 1.2345,
      "cost_status": "known",
      "pricing_catalog_version": "2026-05-15.codexbar-parity",
      "warning_codes": [],
      "has_usage": true,
      "is_missing": false
    }
  ],
  "models": [
    {
      "name": "gpt-5",
      "input_tokens": 100000,
      "cached_input_tokens": 25000,
      "output_tokens": 36000,
      "total_tokens": 136000,
      "estimated_cost_usd": 1.01,
      "cost_status": "known",
      "pricing_catalog_version": "2026-05-15.codexbar-parity",
      "warning_codes": []
    }
  ],
  "collector": {
    "version": "0.1.0",
    "source": "codexbar-local-cost",
    "codex_home": "default",
    "cost_engine_version": "2026-05-15.codexbar-parity",
    "sources": [
      {
        "kind": "codex_sessions",
        "enabled": true,
        "status": "read",
        "record_count": 42
      }
    ],
    "warnings": []
  }
}
```

The real upload can include up to 31 daily rows and up to 25 normalized model rows. It does not include raw session records or anything needed to reconstruct your Codex conversations.

## What Never Gets Sent

The CLI does not upload:

- Prompts or responses
- Tool output
- Shell commands
- File contents
- Diffs
- Absolute paths
- Repository names
- Raw Codex JSONL lines
- Priority database rows
- Pi session contents
- Auth files, browser cookies, API keys, TRMNL secrets, pairing codes, or collector tokens in aggregate uploads

No individual usage data is sent. No raw usage content is analyzed remotely. The private parts of your Codex activity stay local.

## Commands

Open setup or the local control menu:

```bash
npx trmnl-token-meter
```

Show current pairing, background sync, and server status:

```bash
npx trmnl-token-meter status
```

Upload one snapshot immediately:

```bash
npx trmnl-token-meter sync --once
```

Add or replace the paired TRMNL meter:

```bash
npx trmnl-token-meter add
```

Revoke this machine and stop background sync:

```bash
npx trmnl-token-meter revoke
```

Remove background sync:

```bash
npx trmnl-token-meter uninstall
```

By default, `uninstall` keeps local pairing credentials. Use `uninstall --revoke` if you also want to revoke this machine from the TRMNL meter.

## Non-Interactive Setup

For scripts or troubleshooting, pair manually:

```bash
npx trmnl-token-meter pair \
  --code ABCD-1234 \
  --machine-label "My MacBook" \
  --api-base-url https://trmnl-token-meter-backend.trmnltkn.workers.dev
```

Then install background sync:

```bash
npx trmnl-token-meter service install
```

Upload once:

```bash
npx trmnl-token-meter upload
```

## Inspect Before Uploading

Use `collect` to print the exact sanitized payload locally without uploading:

```bash
npx trmnl-token-meter collect
```

This is the best way to verify what would be sent. The output is the aggregate snapshot, not raw Codex content.

## Local Sources

By default, the CLI reads Codex usage from `CODEX_HOME` when set, otherwise `~/.codex`.

Expected local inputs:

- `$CODEX_HOME/sessions/**/*.jsonl`
- `$CODEX_HOME/archived_sessions/**/*.jsonl`
- `$CODEX_HOME/logs_2.sqlite` for priority-tier cost evidence
- `~/.pi/agent/sessions/**/*.jsonl` only when Pi session merging is explicitly enabled

To read another Codex directory:

```bash
CODEX_HOME=/path/to/codex-home npx trmnl-token-meter collect
```

Pi session merging is off by default. Enable it for one command with:

```bash
npx trmnl-token-meter collect --include-pi-sessions
```

## Background Sync

Interactive setup installs background sync automatically.

On macOS, the CLI installs a user `launchd` agent. On Linux, it prefers a user `systemd` timer and falls back to cron when systemd user services are unavailable.

Foreground continuous mode is available for debugging:

```bash
npx trmnl-token-meter run
```

Closing the terminal stops foreground mode. Normal setup uses the background scheduler instead.

## Update Checks

Human-facing commands check npm for a newer `trmnl-token-meter` version at most once per day. Disable that check with either:

```bash
TRMNL_TOKEN_METER_DISABLE_UPDATE_CHECK=1 npx trmnl-token-meter status
npx trmnl-token-meter status --no-update-check
```

## Local Files

The CLI stores its local credential and sync metadata in the platform config directory with restrictive permissions.

- macOS: `~/Library/Application Support/trmnl-token-meter`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/trmnl-token-meter`

The collector credential is used only to authenticate this machine with your TRMNL Token Meter plugin. Revoking the machine invalidates that credential.
