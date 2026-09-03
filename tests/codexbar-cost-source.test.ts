import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { loadConfig } from "../src/config.js";
import { scanLocalCostSources } from "../src/cost-scan.js";
import { findPricingModel } from "../src/pricing/index.js";
import { serializeAggregateForUpload } from "../src/upload.js";
import type { AggregateSnapshot, SourceProvider } from "../src/types.js";

const fixtureRoot = new URL("./fixtures/codex-jsonl/default", import.meta.url).pathname;
const NOW = new Date("2026-05-15T12:00:00.000Z");
const TODAY = "2026-05-15";
const YESTERDAY = "2026-05-14";
const FAKE_VERSION = "9.9.9";

// Deliberately a name the bundled catalog will never carry. That is the whole point
// of the CodexBar path: usage priced upstream must reach the snapshot with real
// dollars, without an entry in src/pricing/models.ts. A real model id would make
// this test expire the moment that model is added to the catalog, which is exactly
// what happened to claude-fable-5-1.
const UNCATALOGUED_MODEL = "unreleased-model-x1";
const CATALOGUED_MODEL = "gpt-5";

interface FakeDay {
  date: string;
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number | null;
  modelBreakdowns: Array<{ modelName: string; totalTokens: number; cost: number | null }>;
}

interface FakePayload {
  provider: string;
  source?: string;
  provenance?: string;
  coverage?: { priced: number; estimated: number; unpriced: number; unmetered: number };
  daily?: FakeDay[];
  error?: { message: string };
  projects?: unknown;
}

/**
 * Installs a stand-in for the CodexBar CLI so the real `execFile` path is exercised
 * without depending on whether the machine running the suite has CodexBar or any
 * particular usage history.
 */
const installFakeCodexBar = async (
  payload: FakePayload[],
  options: { exitCode?: number; stdout?: string } = {}
): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "codexbar-fake-"));
  const binary = join(dir, "codexbar");
  const body = options.stdout ?? JSON.stringify(payload);
  await writeFile(
    binary,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "CodexBar ${FAKE_VERSION}"
  exit 0
fi
if [ "$1" = "cost" ]; then
  echo '${body.replaceAll("'", "'\\''")}'
  exit ${options.exitCode ?? 0}
fi
exit 64
`
  );
  await chmod(binary, 0o755);
  return binary;
};

const claudeDay = (date: string, model: string, cost: number | null): FakeDay => ({
  date,
  inputTokens: 1_000,
  cacheReadTokens: 8_000,
  cacheCreationTokens: 500,
  outputTokens: 500,
  totalTokens: 10_000,
  totalCost: cost,
  modelBreakdowns: [{ modelName: model, totalTokens: 10_000, cost }]
});

const collect = async (
  env: NodeJS.ProcessEnv,
  providers: SourceProvider[] = ["codex", "claude"]
): Promise<AggregateSnapshot> => {
  const dir = await mkdtemp(join(tmpdir(), "codexbar-scan-"));
  const config = loadConfig({
    CODEX_HOME: fixtureRoot,
    TRMNL_TOKEN_METER_OPENCODE_DB: join(dir, "missing-opencode.db"),
    TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: join(dir, "missing-claude"),
    ...env
  });
  const scan = await scanLocalCostSources(config, { enabledProviders: providers });
  return buildAggregate(scan.records, {
    machineId: "mach_1",
    machineLabel: "test",
    codexHomeKind: "default",
    now: NOW,
    sources: scan.sources,
    warnings: scan.warnings,
    enabledProviders: providers,
    providerStatuses: scan.providerStatuses,
    codexBar: scan.codexBar
  });
};

describe("CodexBar cost source", () => {
  it("prices a model the bundled catalog does not know", async () => {
    // The premise of this test: without CodexBar this model has no local price.
    expect(findPricingModel(UNCATALOGUED_MODEL)).toBeNull();

    const binary = await installFakeCodexBar([
      {
        provider: "claude",
        source: "local",
        provenance: "listPriceEstimate",
        coverage: { priced: 1, estimated: 0, unpriced: 0, unmetered: 0 },
        daily: [claudeDay(TODAY, UNCATALOGUED_MODEL, 12.5)]
      }
    ]);

    const snapshot = await collect(
      { CODEXBAR_BIN: binary, TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "claude" },
      ["claude"]
    );

    expect(snapshot.periods.today.total_tokens).toBe(10_000);
    expect(snapshot.periods.today.estimated_cost_usd).toBe(12.5);
    expect(snapshot.periods.today.cost_status).toBe("known");
    expect(snapshot.periods.today.cost_provenance).toBe("codexbar_cli");
    expect(snapshot.periods.today.cost_catalog_versions).toEqual([
      `codexbar-cli-${FAKE_VERSION}`
    ]);
    expect(snapshot.periods.today.warning_codes).toEqual([]);

    const model = snapshot.models.find((entry) => entry.name === UNCATALOGUED_MODEL);
    expect(model?.estimated_cost_usd).toBe(12.5);
    expect(model?.cost_provenance).toBe("codexbar_cli");
    expect(snapshot.collector.codexbar).toEqual({
      available: true,
      version: FAKE_VERSION,
      providers: ["claude"]
    });
  });

  it("reports the bundled catalog as the provenance when CodexBar is off", async () => {
    const snapshot = await collect({ TRMNL_TOKEN_METER_CODEXBAR: "off" }, ["codex"]);

    expect(snapshot.periods.today.cost_provenance).toBe("local_catalog");
    expect(snapshot.periods.today.cost_catalog_versions).toEqual([
      snapshot.periods.today.pricing_catalog_version
    ]);
    expect(snapshot.collector.codexbar.available).toBe(false);
    expect(snapshot.collector.codexbar.providers).toEqual([]);
  });

  it("replaces the local scan for the providers CodexBar priced", async () => {
    const local = await collect({ TRMNL_TOKEN_METER_CODEXBAR: "off" }, ["codex"]);
    expect(local.periods.today.total_tokens).toBe(215);

    const binary = await installFakeCodexBar([
      {
        provider: "codex",
        daily: [
          {
            date: TODAY,
            inputTokens: 900,
            cacheReadTokens: 400,
            outputTokens: 100,
            totalTokens: 1_000,
            totalCost: 3,
            modelBreakdowns: [{ modelName: CATALOGUED_MODEL, totalTokens: 1_000, cost: 3 }]
          }
        ]
      }
    ]);

    const snapshot = await collect({ CODEXBAR_BIN: binary }, ["codex"]);

    // Exactly CodexBar's tokens, not CodexBar's plus the local scan's.
    expect(snapshot.periods.today.total_tokens).toBe(1_000);
    expect(snapshot.periods.today.estimated_cost_usd).toBe(3);
    expect(snapshot.periods.today.cost_provenance).toBe("codexbar_cli");
    // The local scan still ran, so its source status still reports fallback readiness.
    expect(snapshot.collector.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "codex_sessions", status: "read" }),
        expect.objectContaining({ kind: "codexbar_cost", status: "read" })
      ])
    );
  });

  it("keeps the local scan for a provider CodexBar could not price", async () => {
    const binary = await installFakeCodexBar([
      { provider: "codex", error: { message: "cookie source is Off" }, daily: [] }
    ]);

    const snapshot = await collect({ CODEXBAR_BIN: binary }, ["codex"]);

    expect(snapshot.periods.today.total_tokens).toBe(215);
    expect(snapshot.periods.today.cost_provenance).toBe("local_catalog");
    expect(snapshot.collector.codexbar.providers).toEqual([]);
  });

  it("falls back to the local scan when the CodexBar scan fails", async () => {
    const binary = await installFakeCodexBar([], { exitCode: 1, stdout: "boom" });

    const snapshot = await collect({ CODEXBAR_BIN: binary }, ["codex"]);

    expect(snapshot.periods.today.total_tokens).toBe(215);
    expect(snapshot.periods.today.cost_provenance).toBe("local_catalog");
    expect(snapshot.collector.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "codexbar_failed" })])
    );
    expect(snapshot.collector.codexbar.available).toBe(false);
  });

  it("falls back to the bundled catalog for a row CodexBar left unpriced", async () => {
    const binary = await installFakeCodexBar([
      {
        provider: "claude",
        coverage: { priced: 0, estimated: 0, unpriced: 1, unmetered: 0 },
        daily: [claudeDay(TODAY, UNCATALOGUED_MODEL, null)]
      }
    ]);

    const snapshot = await collect(
      { CODEXBAR_BIN: binary, TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "claude" },
      ["claude"]
    );

    // Tokens are still counted; only the dollars are unavailable, because neither
    // CodexBar nor the bundled catalog can price this model.
    expect(snapshot.periods.today.total_tokens).toBe(10_000);
    expect(snapshot.periods.today.estimated_cost_usd).toBeNull();
    expect(snapshot.periods.today.cost_status).toBe("unknown");
    expect(snapshot.periods.today.cost_provenance).toBe("none");
    expect(snapshot.periods.today.warning_codes).toContain("unknown_pricing");
    expect(snapshot.collector.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "codexbar_pricing_incomplete" })])
    );
  });

  it("marks a window that mixes pricing engines", async () => {
    const binary = await installFakeCodexBar([
      {
        provider: "claude",
        daily: [claudeDay(TODAY, UNCATALOGUED_MODEL, 4)]
      },
      {
        provider: "codex",
        daily: [
          {
            date: YESTERDAY,
            inputTokens: 900,
            cacheReadTokens: 0,
            outputTokens: 100,
            totalTokens: 1_000,
            totalCost: null,
            modelBreakdowns: [{ modelName: CATALOGUED_MODEL, totalTokens: 1_000, cost: null }]
          }
        ]
      }
    ]);

    const snapshot = await collect(
      { CODEXBAR_BIN: binary, TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,claude" },
      ["codex", "claude"]
    );

    const week = snapshot.periods.last_7_days;
    expect(week.cost_provenance).toBe("mixed");
    expect(week.cost_catalog_versions).toEqual([
      "2026-09-03.codexbar-parity",
      `codexbar-cli-${FAKE_VERSION}`
    ]);
  });

  it("keeps CodexBar workspace names and paths out of the upload payload", async () => {
    const binary = await installFakeCodexBar([
      {
        provider: "claude",
        daily: [claudeDay(TODAY, UNCATALOGUED_MODEL, 1)],
        projects: [
          {
            name: "CANARY_PROJECT_DO_NOT_UPLOAD",
            path: "/Users/someone/Repos/CANARY_PATH_DO_NOT_UPLOAD",
            totalTokens: 10_000,
            totalCost: 1
          }
        ]
      }
    ]);

    const snapshot = await collect(
      { CODEXBAR_BIN: binary, TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "claude" },
      ["claude"]
    );
    const serialized = serializeAggregateForUpload(snapshot);

    expect(serialized).not.toContain("CANARY_PROJECT_DO_NOT_UPLOAD");
    expect(serialized).not.toContain("CANARY_PATH_DO_NOT_UPLOAD");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("input_tokens");
    expect(serialized).not.toContain("output_tokens");
  });
});
