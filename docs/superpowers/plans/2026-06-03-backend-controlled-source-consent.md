# Backend-Controlled Source Consent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make source collection consent backend-controlled so runner upgrades never start reading newly supported providers until the user enables them in the web config UI.

**Architecture:** Deploy backend compatibility first: accept provider capability metadata, preserve legacy Codex behavior, store per-device source availability separately from enablement, and return the backend-desired `enabled_providers` list in upload responses. Then update the CLI to persist enabled providers, shallow-probe all supported providers, scan only enabled providers, upload provider capability metadata with `collector.version`, consume backend enablement responses, and run at most one immediate reconciliation upload after newly enabled available providers are returned.

**Tech Stack:** TypeScript, pnpm, Vitest, Hono, Cloudflare Workers, D1, Node 22 CLI runtime.

---

## File Structure

### Backend Repo: `/Users/danielmunoz/Repos/trmnl-token-meter-backend`

- Modify `src/schema/warnings.ts`: keep provider constants as source of truth.
- Modify `src/schema/aggregate.ts`: validate optional `collector.supported_providers`, `collector.enabled_providers`, and `collector.provider_statuses`.
- Modify `src/schema/aggregate-schema.json`: mirror the JSON Schema contract.
- Modify `src/schema/legacy-aggregate.ts`: preserve legacy Codex-only normalization.
- Modify `src/services/types.ts`: ensure `CollectorSourceState.status` can represent shallow availability and disabled states.
- Modify `src/services/usage.ts`: merge reported provider capability state without default-enabling new providers; return desired enabled providers.
- Modify `src/services/memory-store.ts`: keep in-memory machine source defaults aligned with D1.
- Modify `src/routes/collector-api.ts`: include `enabled_providers` in `/api/v1/usage` and optionally `/api/v1/status` responses.
- Modify `src/routes/manage.ts`: keep backend-owned source toggles, but block enabling missing/unsupported sources.
- Modify `src/views/manage.ts`: show provider availability and backend-owned enablement with privacy-first copy.
- Modify `src/markup/effective-scope.ts`: make display aggregation respect backend-enabled source state instead of treating every missing state as enabled.
- Modify backend tests under `tests/contracts/`, `tests/unit/`, and `tests/privacy/`.
- Modify backend docs: `README.md`, `docs/how-it-works.md`, `docs/privacy.md`.

### CLI Repo: `/Users/danielmunoz/Repos/trmnl-token-meter-cli`

- Modify `src/types.ts`: add provider capability metadata and upload response enabled-provider fields.
- Modify `src/config.ts`: persist backend-enabled providers with credentials and persist known supported providers in non-secret local source notice state.
- Create `src/source-providers.ts`: supported provider list, labels, source-kind mapping, and validation helpers.
- Create `src/source-availability.ts`: shallow probes for Codex, OpenCode, and Claude.
- Modify `src/cost-scan.ts`: scan only enabled providers while including disabled source statuses.
- Modify `src/aggregate.ts`: include `supported_providers`, `enabled_providers`, and `provider_statuses` under `collector`.
- Modify `src/upload.ts`: parse `enabled_providers` from upload/status responses.
- Modify `src/cli.ts`: apply backend-enabled providers, perform one reconciliation upload, and show the non-blocking upgrade notice.
- Modify `src/service.ts`: pass provider config env vars to installed background runner.
- Modify CLI tests under `tests/`.
- Modify CLI docs: `README.md`, `docs/collector.md`, `docs/privacy.md`, `docs/how-it-works.md`, `docs/aggregate-schema.md`.

---

### Task 1: Backend Contract Acceptance And Response

**Files:**
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/src/schema/aggregate.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/src/schema/aggregate-schema.json`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/src/routes/collector-api.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/src/services/memory-store.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/tests/contracts/usage-upload.test.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/tests/contracts/collector-status.test.ts`

- [ ] **Step 1: Write failing backend contract tests**

In `tests/contracts/usage-upload.test.ts`, add a test that uploads a current aggregate with:

```json
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
  "sources": [
    { "kind": "codex_sessions", "enabled": true, "status": "read", "record_count": 1 },
    { "kind": "opencode_sqlite", "enabled": false, "status": "disabled" },
    { "kind": "claude_projects", "enabled": false, "status": "disabled" }
  ],
  "warnings": []
}
```

Assert:

```ts
expect(response.status).toBe(200);
await expect(response.json()).resolves.toMatchObject({
  ok: true,
  next_upload_after_seconds: 3600,
  enabled_providers: ["codex"]
});
```

In `tests/contracts/collector-status.test.ts`, add a status assertion that paired status responses include `enabled_providers: ["codex"]` for a legacy or default machine.

- [ ] **Step 2: Run failing backend contract tests**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-backend
pnpm exec vitest run tests/contracts/usage-upload.test.ts tests/contracts/collector-status.test.ts
```

Expected: tests fail because aggregate validation rejects the new fields and responses do not include `enabled_providers`.

- [ ] **Step 3: Extend backend aggregate schema**

In `src/schema/aggregate.ts`, add schemas:

```ts
const providerStatusSchema = z
  .object({
    provider: z.enum(sourceProviders),
    status: z.enum(["available", "missing", "unreadable", "malformed", "disabled"]),
    warning_code: warningCodeSchema.optional()
  })
  .strict();

const providerListSchema = z.array(z.enum(sourceProviders)).max(sourceProviders.length);
```

Inside `collector`, add:

```ts
supported_providers: providerListSchema.optional(),
enabled_providers: providerListSchema.optional(),
provider_statuses: z.array(providerStatusSchema).max(sourceProviders.length).optional(),
```

Update `src/schema/aggregate-schema.json` with matching optional fields under `collector.properties`, using `enum` values from `sourceProviders` and the provider status values above. Keep all new fields optional for backward compatibility.

- [ ] **Step 4: Add backend response helper**

In `src/services/usage.ts`, export or add a helper:

```ts
export function enabledProvidersFor(machine: CollectorMachine): SourceProvider[] {
  const providers = machine.sources
    .filter((source) => source.enabled)
    .map((source) => source.provider);
  return providers.length > 0 ? providers : ["codex"];
}
```

Use the same helper from `GET /api/v1/status` and `POST /api/v1/usage`. If the actual implementation keeps this private, return the same value from `UsageService.save` and duplicate only a tiny local helper in the route.

- [ ] **Step 5: Return enabled providers from collector routes**

In `src/routes/collector-api.ts`, add `enabled_providers` to `GET /api/v1/status`:

```ts
enabled_providers: auth.machine.sources.length > 0
  ? auth.machine.sources.filter((source) => source.enabled).map((source) => source.provider)
  : ["codex"],
```

For `POST /api/v1/usage`, use the updated machine/result from `services.usage.save` and return:

```ts
enabled_providers: result.enabledProviders,
```

Adjust `UsageSaveResult` so the success case includes `enabledProviders`.

- [ ] **Step 6: Run backend contract tests**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-backend
pnpm exec vitest run tests/contracts/usage-upload.test.ts tests/contracts/collector-status.test.ts
```

Expected: focused tests pass.

- [ ] **Step 7: Commit backend contract changes**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-backend
git status --short
git add src/schema/aggregate.ts src/schema/aggregate-schema.json src/routes/collector-api.ts src/services/usage.ts src/services/memory-store.ts tests/contracts/usage-upload.test.ts tests/contracts/collector-status.test.ts
git commit -m "feat: accept source consent metadata"
```

### Task 2: Backend Source State Merge And Web Enablement

**Files:**
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/src/services/usage.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/src/markup/effective-scope.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/src/routes/manage.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/src/views/manage.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/tests/unit/markup-render.test.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/tests/contracts/manage-page.test.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/tests/contracts/manage-actions.test.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/tests/privacy/storage-boundaries.test.ts`

- [ ] **Step 1: Write failing source-state tests**

Add tests that prove:

- a new upload reporting `opencode` available stores `opencode` with `enabled: false`
- legacy uploads without provider metadata still store Codex enabled
- existing enabled state is preserved when later uploads report availability
- rendering excludes uploaded non-Codex source summaries until that provider is enabled in machine source state
- the manage page shows available disabled OpenCode as enableable
- the manage route refuses to enable a provider whose latest status is `missing`
- capability metadata containing path-like strings or raw-content canaries is rejected by the schema/privacy boundary

Use expected objects like:

```ts
expect(machine.sources).toContainEqual({
  provider: "opencode",
  enabled: false,
  status: "available",
  lastSeenAt: expect.any(Date),
  warningCode: null
});
```

- [ ] **Step 2: Run failing backend state/UI tests**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-backend
pnpm exec vitest run tests/unit/markup-render.test.ts tests/contracts/manage-page.test.ts tests/contracts/manage-actions.test.ts tests/privacy/storage-boundaries.test.ts
```

Expected: tests fail because newly detected providers are currently default-enabled and source toggles do not distinguish missing from available consent.

- [ ] **Step 3: Replace default-enabled source merge**

In `src/services/usage.ts`, replace `sourceStatesFor` with logic equivalent to:

```ts
private sourceStatesFor(machine: CollectorMachine, payload: AggregatePayload, receivedAt: Date) {
  const existing = new Map(machine.sources.map((source) => [source.provider, source]));
  const collected = new Set(
    payload.source_summaries && payload.source_summaries.length > 0
      ? payload.source_summaries.map((summary) => summary.provider)
      : ["codex" as const]
  );
  const reportedStatuses = new Map(
    (payload.collector.provider_statuses ?? []).map((status) => [status.provider, status])
  );
  const reportedProviders = new Set([
    ...collected,
    ...(payload.collector.supported_providers ?? []),
    ...reportedStatuses.keys()
  ]);
  if (reportedProviders.size === 0) reportedProviders.add("codex");

  return sourceProviders
    .filter((provider) => reportedProviders.has(provider) || existing.has(provider))
    .map((provider) => {
      const current = existing.get(provider);
      const reported = reportedStatuses.get(provider);
      const wasCollected = collected.has(provider);
      const isLegacyCodex = provider === "codex" && !payload.collector.supported_providers;
      const enabled = current?.enabled ?? isLegacyCodex;
      return {
        provider,
        enabled,
        status: enabled ? (reported?.status ?? (wasCollected ? "available" : current?.status ?? "missing")) : (reported?.status ?? current?.status ?? "missing"),
        lastSeenAt: wasCollected || reported?.status === "available" ? receivedAt : current?.lastSeenAt ?? null,
        warningCode: reported?.warning_code ?? current?.warningCode ?? null
      };
    });
}
```

Adjust names/types to compile. Preserve current source ordering.

- [ ] **Step 4: Update manage source toggle validation**

In `src/markup/effective-scope.ts`, adjust source filtering so missing source state is only treated as enabled for legacy Codex. Use logic equivalent to:

```ts
function sourceEnabled(machine: CollectorMachine, provider: SourceProvider): boolean {
  const state = machine.sources.find((source) => source.provider === provider);
  if (state) return state.enabled;
  return provider === "codex" && machine.sources.length === 0;
}
```

Use this helper wherever source summaries are included in display aggregation.

- [ ] **Step 5: Update manage source toggle validation**

In `src/routes/manage.ts`, before enabling a source, reject missing/unreadable/malformed/unsupported source states:

```ts
if (enabled && (!existing || existing.status !== "available")) {
  return c.text(`${sourceLabels[provider]} is not available on this device yet.`, 400);
}
```

Keep disabling always allowed.

- [ ] **Step 6: Update management copy and controls**

In `src/views/manage.ts`, update `sourceToggleForm` so:

- available disabled sources render an `Enable` button
- enabled sources render an `Enabled` or `Disable` button
- missing/unreadable/malformed sources render disabled explanatory text instead of an enable form

Use copy:

```html
<p class="helper">Enable sources here. The collector will read them on the next sync; raw prompts, responses, commands, paths, OpenCode messages, and Claude transcripts stay local.</p>
```

- [ ] **Step 7: Run focused backend tests**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-backend
pnpm exec vitest run tests/unit/markup-render.test.ts tests/contracts/manage-page.test.ts tests/contracts/manage-actions.test.ts tests/contracts/usage-upload.test.ts tests/contracts/collector-status.test.ts tests/privacy/storage-boundaries.test.ts
```

Expected: focused backend tests pass.

- [ ] **Step 8: Commit backend source-state changes**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-backend
git status --short
git add src/services/usage.ts src/markup/effective-scope.ts src/routes/manage.ts src/views/manage.ts tests/unit/markup-render.test.ts tests/contracts/manage-page.test.ts tests/contracts/manage-actions.test.ts tests/privacy/storage-boundaries.test.ts
git commit -m "feat: manage source enablement on backend"
```

### Task 3: CLI Provider Config, Probes, And Scan Gating

**Files:**
- Create: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/src/source-providers.ts`
- Create: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/src/source-availability.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/src/types.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/src/config.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/src/cost-scan.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/tests/config.test.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/tests/cost-sources.test.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/tests/cost-scan.test.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/tests/privacy-canaries.test.ts`

- [ ] **Step 1: Write failing CLI config and scan tests**

Add tests that assert:

- missing credential provider config defaults to `enabledProviders: ["codex"]`
- env `TRMNL_TOKEN_METER_ENABLED_PROVIDERS=codex,opencode` is parsed for service/runtime overrides
- disabled OpenCode and Claude are shallow-probed but not scanned
- disabled source statuses use `enabled: false` and `status: "disabled"`
- privacy canaries inside disabled OpenCode/Claude files are not serialized

Expected scan status example:

```ts
expect(result.sources).toContainEqual({
  kind: "opencode_sqlite",
  enabled: false,
  status: "disabled"
});
```

- [ ] **Step 2: Run failing CLI focused tests**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-cli
pnpm test tests/config.test.ts tests/cost-sources.test.ts tests/cost-scan.test.ts tests/privacy-canaries.test.ts
```

Expected: tests fail because enabled provider config and gated scans do not exist.

- [ ] **Step 3: Add provider constants and validation**

Create `src/source-providers.ts`:

```ts
import type { LocalUsageSourceKind, LocalUsageSourceStatus, SourceProvider } from "./types.js";

export const SUPPORTED_PROVIDERS: SourceProvider[] = ["codex", "opencode", "claude"];

export const providerLabels: Record<SourceProvider, string> = {
  codex: "Codex",
  opencode: "OpenCode",
  claude: "Claude"
};

export const providerSourceKinds: Record<SourceProvider, LocalUsageSourceKind[]> = {
  codex: ["codex_sessions", "codex_archived_sessions", "codex_priority_sqlite"],
  opencode: ["opencode_sqlite"],
  claude: ["claude_projects"]
};

export function parseProviders(value: string | undefined, fallback: SourceProvider[]): SourceProvider[] {
  if (!value?.trim()) return fallback;
  const providers = value
    .split(",")
    .map((part) => part.trim())
    .filter((part): part is SourceProvider => (SUPPORTED_PROVIDERS as string[]).includes(part));
  return [...new Set(providers)];
}

export function disabledSourceStatus(kind: LocalUsageSourceKind): LocalUsageSourceStatus {
  return { kind, enabled: false, status: "disabled" };
}
```

- [ ] **Step 4: Add shallow availability probes**

Create `src/source-availability.ts` with content-free checks:

```ts
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectorConfig } from "./config.js";
import type { ProviderStatus, SourceProvider } from "./types.js";
import { SUPPORTED_PROVIDERS } from "./source-providers.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function hasJsonlFile(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.endsWith(".jsonl")) ||
      entries.some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}

export async function probeProviderStatus(config: CollectorConfig, provider: SourceProvider): Promise<ProviderStatus> {
  if (provider === "codex") {
    const sessions = join(config.codexHome, "sessions");
    return (await readable(sessions))
      ? { provider, status: "available" }
      : { provider, status: "missing", warning_code: "codex_sessions_missing" };
  }
  if (provider === "opencode") {
    if (!(await exists(config.opencodeDbPath))) return { provider, status: "missing", warning_code: "opencode_sqlite_missing" };
    return (await readable(config.opencodeDbPath))
      ? { provider, status: "available" }
      : { provider, status: "unreadable", warning_code: "opencode_sqlite_unreadable" };
  }
  const roots = config.claudeProjectsRoots ?? [
    join(homedir(), ".config", "claude", "projects"),
    join(homedir(), ".claude", "projects")
  ];
  const available = await Promise.all(roots.map(hasJsonlFile));
  return available.some(Boolean) ? { provider, status: "available" } : { provider, status: "missing" };
}

export async function probeProviderStatuses(config: CollectorConfig): Promise<ProviderStatus[]> {
  return Promise.all(SUPPORTED_PROVIDERS.map((provider) => probeProviderStatus(config, provider)));
}
```

- [ ] **Step 5: Extend CLI types and config**

In `src/types.ts`, add:

```ts
export interface ProviderStatus {
  provider: SourceProvider;
  status: "available" | LocalUsageSourceStatusValue;
  warning_code?: WarningCode;
}
```

In `CollectorConfig`, add:

```ts
enabledProviders: SourceProvider[];
```

In `loadConfig`, parse:

```ts
enabledProviders: parseProviders(env.TRMNL_TOKEN_METER_ENABLED_PROVIDERS, ["codex"]),
```

In `CollectorCredential`, add:

```ts
enabled_providers?: SourceProvider[];
```

When a credential exists, collection should prefer `credential.enabled_providers ?? config.enabledProviders ?? ["codex"]` so backend-owned enablement is stored with the rest of the backend-owned machine state. Keep `TRMNL_TOKEN_METER_ENABLED_PROVIDERS` as a service/runtime override for the copied runner.

- [ ] **Step 6: Gate scanner by enabled providers**

Change `scanLocalCostSources(config)` so it:

- only calls Codex readers when `enabledProviders` contains `codex`
- only calls OpenCode reader when enabled
- only calls Claude reader when enabled
- returns disabled statuses for disabled source kinds
- still reads priority evidence only when Codex is enabled

Keep Pi sessions controlled by the existing Pi opt-in and independent from provider consent.

- [ ] **Step 7: Run CLI focused tests**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-cli
pnpm test tests/config.test.ts tests/cost-sources.test.ts tests/cost-scan.test.ts tests/privacy-canaries.test.ts
```

Expected: focused tests pass.

- [ ] **Step 8: Commit CLI scan gating changes**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-cli
git status --short
git add src/source-providers.ts src/source-availability.ts src/types.ts src/config.ts src/cost-scan.ts tests/config.test.ts tests/cost-sources.test.ts tests/cost-scan.test.ts tests/privacy-canaries.test.ts
git commit -m "feat: gate local source collection by provider consent"
```

### Task 4: CLI Upload Reconciliation And Notice

**Files:**
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/src/aggregate.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/src/upload.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/src/cli.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/src/service.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/tests/upload.test.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/tests/cli.test.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/tests/service.test.ts`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/tests/aggregate.property.ts`

- [ ] **Step 1: Write failing CLI upload and notice tests**

Add tests that assert:

- serialized aggregate includes `collector.version`, `supported_providers`, `enabled_providers`, and `provider_statuses`
- `uploadAggregate` parses `enabled_providers`
- `uploadOnce` saves backend provider differences
- newly enabled locally available OpenCode triggers one immediate second upload
- `--help` and `--version` still do not refresh or notice
- human-facing commands print a privacy-first notice when current supported providers differ from known supported providers
- service env includes `TRMNL_TOKEN_METER_ENABLED_PROVIDERS`

Use expected notice copy:

```text
New local sources are supported: OpenCode, Claude.
They are not collected until enabled in the TRMNL Token Meter web config.
Raw prompts, responses, commands, paths, OpenCode messages, and Claude transcripts stay on this machine.
```

- [ ] **Step 2: Run failing CLI upload tests**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-cli
pnpm test tests/upload.test.ts tests/cli.test.ts tests/service.test.ts tests/aggregate.property.ts
```

Expected: tests fail because metadata, response parsing, reconciliation, notice, and service env do not exist.

- [ ] **Step 3: Add aggregate provider metadata**

Extend `buildAggregate` options with:

```ts
supportedProviders?: SourceProvider[];
enabledProviders?: SourceProvider[];
providerStatuses?: ProviderStatus[];
```

Under `collector`, add:

```ts
supported_providers: options.supportedProviders ?? SUPPORTED_PROVIDERS,
enabled_providers: options.enabledProviders ?? ["codex"],
provider_statuses: options.providerStatuses ?? [],
```

Update type definitions and serializer tests accordingly.

- [ ] **Step 4: Parse backend enabled providers**

In `src/upload.ts`, extend the upload response type:

```ts
enabled_providers: SourceProvider[] | null;
```

Parse with a helper that keeps only known providers:

```ts
const enabledProviders = Array.isArray((body as Record<string, unknown>).enabled_providers)
  ? (body as Record<string, unknown>).enabled_providers.filter((value): value is SourceProvider =>
      typeof value === "string" && (SUPPORTED_PROVIDERS as string[]).includes(value)
    )
  : null;
```

- [ ] **Step 5: Add local provider state persistence**

Persist known-provider notice state in a local non-secret JSON file under the existing config directory, for example `source-state.json`:

```json
{
  "known_supported_providers": ["codex", "opencode", "claude"]
}
```

Add helpers in `src/config.ts`:

```ts
export async function loadSourceNoticeState(config: CollectorConfig): Promise<SourceNoticeState>;
export async function saveSourceNoticeState(config: CollectorConfig, state: SourceNoticeState): Promise<void>;
```

Make missing file default to `known_supported_providers: ["codex"]`. Save backend-owned `enabled_providers` on `credentials.json`, not this notice state file.

- [ ] **Step 6: Reconcile upload response and bounded follow-up**

In `uploadOnce`, after the first upload response:

1. Save interval as today.
2. If `response.enabled_providers` is present and differs from `credential.enabled_providers ?? ["codex"]`, save it on the credential.
3. If the response newly enables at least one provider whose shallow status is `available`, run exactly one second collect/upload with the updated enabled providers.
4. Do not recursively reconcile the second upload.

Implement with a parameter:

```ts
async function uploadOnce(config: CollectorConfig, options: { allowProviderReconcile?: boolean } = { allowProviderReconcile: true })
```

Second call passes `{ allowProviderReconcile: false }`.

- [ ] **Step 7: Add privacy-first notice**

In `main`, after early `--help`/`--version` returns and before command dispatch, load source notice state. For human-facing commands, if `SUPPORTED_PROVIDERS` contains providers absent from `known_supported_providers`, print the notice to stderr and save updated known providers. Do not prompt. Do not show for `collect` because it emits JSON to stdout; if shown for `collect`, it must be stderr-only and covered by tests. Do not show for `sync --once`, `sync --due`, `run`, or service commands.

- [ ] **Step 8: Pass provider env to background runner**

In `src/service.ts`, add to `envForService`:

```ts
TRMNL_TOKEN_METER_ENABLED_PROVIDERS: config.enabledProviders.join(","),
```

Ensure install/refresh uses current saved credential enabled providers before writing service metadata. Do not pass notice state to background runners.

- [ ] **Step 9: Run CLI focused tests**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-cli
pnpm test tests/upload.test.ts tests/cli.test.ts tests/service.test.ts tests/aggregate.property.ts tests/config.test.ts tests/cost-scan.test.ts
```

Expected: focused tests pass.

- [ ] **Step 10: Commit CLI upload reconciliation changes**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-cli
git status --short
git add src/aggregate.ts src/upload.ts src/cli.ts src/service.ts src/config.ts src/types.ts tests/upload.test.ts tests/cli.test.ts tests/service.test.ts tests/aggregate.property.ts tests/config.test.ts tests/cost-scan.test.ts
git commit -m "feat: reconcile source consent with backend"
```

### Task 5: Cross-Repo Docs, Privacy, And Final Verification

**Files:**
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/README.md`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/docs/how-it-works.md`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-backend/docs/privacy.md`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/README.md`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/docs/collector.md`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/docs/privacy.md`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/docs/how-it-works.md`
- Modify: `/Users/danielmunoz/Repos/trmnl-token-meter-cli/docs/aggregate-schema.md`

- [ ] **Step 1: Update docs**

Document:

- new providers are not collected automatically after runner upgrade
- web config owns source enablement
- CLI sends source capability metadata and current `collector.version` on each sync
- disabled provider availability probes are shallow and content-free
- backend returns enabled providers and CLI may immediately resync once after a user enables an available source

- [ ] **Step 2: Run backend quality gates**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-backend
pnpm run typecheck
pnpm test
pnpm run test:contracts
pnpm run test:privacy
```

Expected: all backend checks pass.

- [ ] **Step 3: Run CLI quality gates**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-cli
pnpm typecheck
pnpm lint
pnpm test
pnpm test:privacy
pnpm build
```

Expected: all CLI checks pass.

- [ ] **Step 4: Inspect final git state**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-backend
git status --short
git log --oneline -5

cd /Users/danielmunoz/Repos/trmnl-token-meter-cli
git status --short
git log --oneline -5
```

Expected: only task-related changes are present in backend; CLI may still show pre-existing unrelated docs changes that must remain untouched.

- [ ] **Step 5: Commit docs**

```bash
cd /Users/danielmunoz/Repos/trmnl-token-meter-backend
git add README.md docs/how-it-works.md docs/privacy.md
git commit -m "docs: describe backend source consent"

cd /Users/danielmunoz/Repos/trmnl-token-meter-cli
git add README.md docs/collector.md docs/privacy.md docs/how-it-works.md docs/aggregate-schema.md
git commit -m "docs: describe backend-controlled source consent"
```

If any listed CLI docs have pre-existing unrelated changes, include only hunks related to this task and leave unrelated changes unstaged.
