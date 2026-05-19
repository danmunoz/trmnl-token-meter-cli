# Collector

The collector reads local Codex usage sources, calculates CodexBar-parity token and estimated cost aggregates, and uploads only sanitized summaries to the hosted TRMNL Token Meter backend.

## Setup

Generate a pairing code from the TRMNL management page, then run the CLI:

```bash
npx trmnl-token-meter
```

The interactive setup asks for the pairing code, a machine name, and the backend
URL when needed. It pairs the machine, uploads the first sanitized snapshot, and
installs background sync automatically.

The background sync uses a stable local copy of the npm package runtime, so it
does not depend on the temporary `npx` cache after setup. On macOS it installs a
user `launchd` agent. On Linux it prefers a user `systemd` timer and falls back
to cron when systemd user services are unavailable.

For scripts or troubleshooting, the non-interactive pairing command remains:

```bash
npx trmnl-token-meter pair \
  --code ABCD-1234 \
  --machine-label "Daniel MacBook" \
  --api-base-url https://token-meter.example.com
```

The collector stores the returned machine ID and bearer credential in the platform config directory with restrictive permissions.

Install background sync after non-interactive pairing with:

```bash
npx trmnl-token-meter service install
```

## Manage

Run the CLI with no arguments to open the local control panel:

```bash
npx trmnl-token-meter
```

Available direct commands:

```bash
npx trmnl-token-meter status
npx trmnl-token-meter sync --once
npx trmnl-token-meter add
npx trmnl-token-meter revoke
npx trmnl-token-meter uninstall
```

Human-facing commands check npm for a newer `trmnl-token-meter` version at most
once per day and print a non-blocking update notice when one is available. Skip
that check with:

```bash
TRMNL_TOKEN_METER_DISABLE_UPDATE_CHECK=1 npx trmnl-token-meter status
npx trmnl-token-meter status --no-update-check
```

Only one TRMNL meter can be paired on a machine at a time. Adding another meter
replaces the current local pairing.

`uninstall` removes the background sync service and keeps pairing credentials by
default. Use `uninstall --revoke` or `revoke` to stop the service, revoke the
server-side collector credential, and delete the local credential.

## Custom Codex Location

By default, the collector uses `CODEX_HOME` when set and otherwise `~/.codex`. To read another location, set `CODEX_HOME` for the command:

```bash
CODEX_HOME=/path/to/codex-home npx trmnl-token-meter collect
```

Only expected local usage inputs are scanned:

- `$CODEX_HOME/sessions/**/*.jsonl`
- `$CODEX_HOME/archived_sessions/**/*.jsonl`
- `$CODEX_HOME/logs_2.sqlite` for priority-tier cost evidence
- `~/.pi/agent/sessions/**/*.jsonl` only when Pi merging is explicitly enabled

The collector does not upload raw lines, prompts, responses, file paths, commands, diffs, SQL rows, Pi session content, or repository names.

## Optional Pi Session Merge

Pi sessions are disabled by default. Enable them for one command with:

```bash
npx trmnl-token-meter collect --include-pi-sessions
```

or set:

```bash
TRMNL_TOKEN_METER_INCLUDE_PI_SESSIONS=1
```

Disabled Pi collection is silent and does not create a missing-source warning.

## Cost Windows And Status

Each collector run captures the local date once, then calculates today, last 7 days, last 30 days, and up to 31 daily rows using local-day boundaries. Cost estimates use the local CodexBar-parity catalog version included in the upload.

Cost status meanings:

- `known`: all included rows have supported pricing and required evidence.
- `partial`: token totals are complete, but at least one price or modifier is unknown.
- `unknown`: token usage exists, but no included row has known pricing.
- `disabled`: cost display was disabled by configuration.

Generic warning codes include missing/unreadable local sources, malformed rows, unknown pricing, long-context uncertainty, priority evidence problems, duplicate records, stale upload, and rejected upload. Warnings never include local paths or raw row details.

## Dry Run

Use `collect` to inspect the sanitized aggregate payload locally without uploading:

```bash
npx trmnl-token-meter collect
```

The output must conform to the aggregate schema and must not include privacy canary values.

## Upload Once

After pairing:

```bash
npx trmnl-token-meter upload
```

Upload sends one sanitized aggregate snapshot and exits. Rejected uploads print a generic redacted error.

## Background And Foreground Sync

Published setup installs background sync. The service runs a one-shot upload on
the configured interval, so syncing continues after the terminal closes and after
normal restarts.

Use this command for the scheduler or a manual one-shot sync:

```bash
npx trmnl-token-meter sync --once
```

Foreground continuous mode is still available for development and debugging:

To upload on the default 60-minute interval:

```bash
npx trmnl-token-meter run
```

Closing the terminal stops foreground continuous mode.
