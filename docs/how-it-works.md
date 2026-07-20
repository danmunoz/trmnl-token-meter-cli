# How It Works

TRMNL Token Meter has two active runtime surfaces:

- The hosted Cloudflare Worker backend with D1 storage.
- This repository: the local `trmnl-token-meter` collector package intended for `npx`.

The CLI includes its cost catalog under `src/pricing/`. The published npm
package ships only the built `dist/` output.

## Data Flow

1. A TRMNL user installs the plugin through the Cloudflare Worker install route.
2. The Worker activates the TRMNL connection through the install-success webhook.
3. The user opens the management page and generates a one-time pairing code.
4. The user runs `npx trmnl-token-meter`, enters the pairing code and machine
   name, and the local CLI exchanges that pairing code through `POST /api/v1/pair`.
5. The CLI uploads the first sanitized snapshot, then installs a background
   scheduler using a stable local copy of the package runtime.
6. The background scheduler runs `sync --once` on the configured interval. The
   CLI checks supported providers for local availability without reading
   disabled source content, scans only the providers enabled for this device by
   the backend, builds a sanitized aggregate, and uploads only that aggregate
   plus collector version and source availability metadata to
   `POST /api/v1/usage`.
7. TRMNL calls `POST /trmnl/markup`; the Worker renders the display payload from
   stored aggregate snapshots and display preferences.

Raw session lines, prompts, responses, commands, paths, diffs, repository names,
auth files, cookies, API keys, pairing codes, and collector bearer tokens are not
uploaded by the collector.

The upload includes combined totals plus optional `source_summaries` for enabled
providers found locally. The supported providers are `codex`, `opencode`, and
`claude`. Public usage sections expose total tokens and estimated cost only;
provider-specific token lanes stay local for cost calculation. OpenCode cost
totals use the stored per-message `cost` value from the local OpenCode database.

Source enablement is owned by the backend web configuration. A newer CLI release
can report that new providers are supported and locally available, but it does
not start aggregating those providers until the backend response includes them in
`enabled_providers`. When that response enables a newly available provider, the
CLI updates its local credential and performs one immediate follow-up sync.

## Local CLI

The CLI entry point is `src/cli.ts`. Implemented commands are:

- `setup`
- `status`
- `add`
- `revoke`
- `uninstall`
- `service install|status|uninstall`
- `sync --once`
- `pair --code <code> [--machine-label <label>] [--api-base-url <url>] [--replace]`
- `collect`
- `upload`
- `run [--once]`

Running the CLI with no arguments opens the interactive setup/status menu.
`setup` pairs the machine, sends the first upload, and installs background sync.
`sync --once` is the service-safe one-shot uploader. `collect` prints the
sanitized aggregate JSON to stdout. `upload` remains a manual one-shot upload.
`run` remains foreground continuous mode for debugging.

## Hosted Backend

The hosted Cloudflare backend owns:

- TRMNL install, install-success, markup, management, and uninstall routes.
- Collector pair, status, usage upload, and revoke routes.
- D1 migrations and storage access.
- TRMNL layout rendering.
- Aggregate validation, privacy canaries, and redaction.

Operational setup and deployment are maintained with the backend service.

## Packaging

The CLI package is prepared for npm publication from this repository root.

The package manifest includes:

- `bin.trmnl-token-meter = dist/cli.js`
- `files = ["dist"]`

That means `npm publish` ships only the built CLI output and package metadata.
