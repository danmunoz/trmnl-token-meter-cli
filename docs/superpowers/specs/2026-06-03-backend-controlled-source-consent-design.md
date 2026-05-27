# Backend-Controlled Source Consent Design

## Goal

Add explicit user consent for newly supported local usage providers without making the CLI a configuration surface.

When a newer CLI release supports additional providers, upgrading the foreground CLI or installed background runner must not automatically start reading those providers. The CLI should only read providers that the backend has enabled for that paired device. The backend management UI owns source enablement.

## Current Behavior

The CLI currently scans Codex, OpenCode, and Claude on every local collection attempt. Missing OpenCode and Claude sources are non-fatal, but available sources are read automatically.

The backend already stores per-device source state in `collector_machines.source_settings_json` and exposes source toggles on the management page. Its current save path derives detected providers from uploaded source summaries and defaults newly detected providers to enabled. That default is not acceptable for explicit consent.

The CLI already sends its current package version on every sync through the aggregate `collector.version` field. The backend stores that value as the machine collector version during usage saves. This behavior should remain part of the contract.

## Principles

- Newly supported providers are disabled by default.
- CLI runner upgrades add capability only; they do not change enabled sources.
- Local source availability checks must be shallow and content-free.
- Disabled providers must not be read, aggregated, uploaded, or priced.
- The web management UI is the only place where users enable or disable sources.
- Backend responses are the source of truth for the paired device's enabled providers.
- A backend enablement change should take effect quickly without waiting for the next scheduled interval.

## Provider State Model

The CLI should distinguish these concepts:

- `supported`: the current CLI binary knows how to collect this provider.
- `available`: a shallow local probe found evidence that this provider can be collected on this machine.
- `enabled`: the backend has authorized this provider for collection on this paired device.
- `collected`: the provider was actually scanned and contributed data in this upload.

The backend should store per-device source state with the same conceptual split:

- provider id, such as `codex`, `opencode`, or `claude`
- enabled flag controlled by the web UI
- availability/status last reported by the CLI
- last seen timestamp for provider availability or collection
- warning code when the shallow status or collected status is unavailable, unreadable, or malformed

Missing local config from older CLI installs should be interpreted as:

- supported providers: `["codex"]`
- enabled providers: `["codex"]`

## CLI Upload Contract

Each usage upload should continue to include the current sanitized aggregate shape and `collector.version`.

The aggregate should add explicit source capability metadata under `collector`, for example:

```json
{
  "collector": {
    "version": "0.3.0",
    "source": "codexbar-local-cost",
    "codex_home": "default",
    "cost_engine_version": "2026-06-02.codexbar-parity",
    "supported_providers": ["codex", "opencode", "claude"],
    "enabled_providers": ["codex"],
    "provider_statuses": [
      { "provider": "codex", "status": "available" },
      { "provider": "opencode", "status": "available" },
      { "provider": "claude", "status": "missing" }
    ],
    "sources": [],
    "warnings": []
  }
}
```

The contract should use these field names unless implementation discovers an existing backend convention that makes a different name clearly safer:

- `supported_providers`: provider ids this CLI release can collect.
- `enabled_providers`: provider ids the CLI considered enabled for this upload.
- `provider_statuses`: shallow provider availability statuses for all supported providers.
- `collector.sources`: scan statuses for enabled local source kinds only.

`collector.sources` can continue to represent scan statuses for enabled providers. It should not be the only way to infer availability because disabled providers must not be scanned.

## Backend Upload Response

`POST /api/v1/usage` should return the backend-desired enabled provider list for the authenticated machine:

```json
{
  "ok": true,
  "next_upload_after_seconds": 3600,
  "enabled_providers": ["codex", "opencode"],
  "server_time": "2026-06-03T10:00:00.000Z"
}
```

The response list is authoritative for the paired machine. The CLI should save it locally after validating that all returned providers are supported by the current CLI. Unsupported providers should be ignored locally and reported on the next sync as unsupported by omission from `supported_providers`.

The backend can also expose the same enabled provider list through `GET /api/v1/status`, but usage upload response is the required path because the background runner already syncs through that endpoint.

## CLI Sync Flow

1. Load local config and credential.
2. Refresh the installed runner if the foreground CLI is newer.
3. Load local enabled providers. If missing, default to `["codex"]`.
4. Run shallow availability probes for all supported providers.
5. Scan and aggregate only enabled providers that are available.
6. Upload the aggregate plus source capability metadata.
7. Read `enabled_providers` from the backend response.
8. If the backend list differs from local enabled providers, save the backend list.
9. If newly enabled providers are available locally, immediately run one follow-up upload with the new provider set.

The immediate follow-up must be bounded to avoid loops. A single upload command may perform at most one reconciliation upload caused by backend source changes.

If the backend disables a provider, the CLI saves that change and does not need a follow-up upload unless the original upload included now-disabled data. Because the backend response arrives after the upload, the simpler rule is: apply the change for future runs and only follow up when a newly enabled, locally available provider can add missing data.

## CLI Notice UX

Human-facing CLI commands should show a privacy-first informational notice when the current CLI supports providers that the previous known provider set did not include.

The notice should:

- mention only newly supported providers
- explain that raw prompts, responses, commands, paths, OpenCode messages, and Claude transcripts stay local
- state that new providers are not collected until enabled in the web config
- direct the user to the management page

It should not offer CLI source configuration choices.

Background and service-safe commands must not block for prompts. If they print anything, it should be a short non-blocking notice only.

## Web Management UI

The backend management page should be the source configuration surface.

For each paired device, show supported and locally available providers from the latest CLI sync:

- Enabled and available providers can be disabled.
- Available but disabled providers can be enabled.
- Supported but missing providers should be visible but not enableable, or enableable with clear copy that no data will upload until the source appears locally. The safer default is not enableable.
- Providers unsupported by that device's current CLI should be hidden or shown as unavailable with upgrade guidance.

The UI should keep the existing source toggles but update copy to clarify:

- enabling a source tells the next collector sync to read it
- disabling a source stops future collection for that provider
- raw local content remains on the user's machine

## Backend Save Behavior

Backend usage save must stop treating newly detected providers as enabled by default.

When a usage upload arrives:

- update the machine collector version from `collector.version`
- merge reported supported/available provider states into `source_settings_json`
- preserve existing `enabled` values when a provider already exists
- default newly reported providers to `enabled: false`, except legacy migration for missing source config defaults Codex to enabled
- store collected providers from `source_summaries` as available and last seen
- return the effective enabled provider list in the upload response

Legacy uploads without provider capability metadata should continue to behave as Codex-only uploads.

## Privacy

Availability probes must not inspect raw content:

- Codex: check for expected directories or files, not JSONL line contents.
- OpenCode: check database path existence/readability, not table rows.
- Claude: check configured/default project directory existence and file presence, not JSONL contents.

The upload may include provider ids and generic availability statuses. It must not include local paths, database names, project names, transcript contents, prompts, responses, commands, diffs, or raw SQL details.

## Testing

CLI coverage should include:

- old config migration defaults enabled providers to Codex
- disabled OpenCode and Claude are shallow-probed but not scanned
- aggregate includes `collector.version` and source capability metadata
- backend response provider differences update local config
- newly enabled available provider triggers exactly one immediate follow-up sync
- unavailable newly enabled provider does not trigger a follow-up scan
- background runner env/config uses saved enabled providers
- privacy canaries for disabled providers are not serialized

Backend coverage should include:

- aggregate schema accepts capability metadata
- usage save defaults newly reported providers to disabled
- legacy uploads still produce Codex-enabled state
- management UI shows available disabled sources
- management source toggle changes returned `enabled_providers`
- upload response includes desired enabled providers
- backend stores CLI version from every sync
- privacy tests reject local paths or raw content in capability metadata

## Rollout

This change requires coordinated releases:

1. Backend accepts new metadata while remaining compatible with existing CLI uploads.
2. Backend management UI exposes source enablement based on reported availability.
3. CLI release sends provider capability metadata, respects backend-enabled providers, and shows the informational notice.

The backend should be deployed before the CLI release so the new CLI can receive `enabled_providers` immediately.
