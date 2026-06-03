import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { scanLocalCostSources } from "../src/cost-scan.js";
import type { SessionUsageRecord } from "../src/types.js";

const writeJsonl = async (path: string, lines: string[]) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`);
};

const makeTempRoot = async () => {
  return await mkdtemp(join(tmpdir(), "trmnl-token-meter-"));
};

const createOpenCodeDb = async (
  path: string,
  row: {
    id: string;
    time_created: string;
    model: string;
    tokens_input: number;
    tokens_cache_read: number;
    tokens_cache_write: number;
    tokens_output: number;
    tokens_reasoning: number;
    cost?: number;
  }
) => {
  const sqlite = (await import("node:sqlite")) as {
    DatabaseSync: new (
      path: string
    ) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...values: unknown[]): void;
      };
      close(): void;
    };
  };
  const db = new sqlite.DatabaseSync(path);
  db.exec(`
    create table session (
      id text primary key,
      time_created text,
      model text,
      tokens_input integer,
      tokens_cache_read integer,
      tokens_cache_write integer,
      tokens_output integer,
      tokens_reasoning integer,
      cost real
    )
  `);
  const statement = db.prepare(
    `
    insert into session (
      id,
      time_created,
      model,
      tokens_input,
      tokens_cache_read,
      tokens_cache_write,
      tokens_output,
      tokens_reasoning,
      cost
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `
  );
  statement.run(
    row.id,
    row.time_created,
    row.model,
    row.tokens_input,
    row.tokens_cache_read,
    row.tokens_cache_write,
    row.tokens_output,
    row.tokens_reasoning,
    row.cost ?? null
  );
  db.close();
};

const record = (overrides: Partial<SessionUsageRecord> = {}): SessionUsageRecord => ({
  dedupe_key: "s1:2026-05-15T10:00:00.000Z:gpt-5:100:10:50",
  source_provider: "codex",
  source_kind: "codex_sessions",
  occurred_at: new Date("2026-05-15T10:00:00.000Z"),
  local_date: "2026-05-15",
  model: "gpt-5",
  model_alias: "gpt-5",
  input_tokens: 100,
  cached_input_tokens: 10,
  output_tokens: 50,
  long_context: false,
  priority_tier: "base",
  pricing_known: true,
  ...overrides
});

const expectNoTokenMix = (value: unknown): void => {
  const text = JSON.stringify(value);
  expect(text).not.toContain("input_tokens");
  expect(text).not.toContain("cached_input_tokens");
  expect(text).not.toContain("output_tokens");
  expect(text).not.toContain("token_breakdown");
};

describe("cost aggregation windows", () => {
  it("uses captured local-day windows for today, last 7 days, last 14 days, and last 30 days", () => {
    const snapshot = buildAggregate(
      [
        record(),
        record({
          dedupe_key: "s2",
          occurred_at: new Date("2026-05-09T10:00:00.000Z"),
          local_date: "2026-05-09"
        }),
        record({
          dedupe_key: "s14",
          occurred_at: new Date("2026-05-02T10:00:00.000Z"),
          local_date: "2026-05-02"
        }),
        record({
          dedupe_key: "s3",
          occurred_at: new Date("2026-04-16T10:00:00.000Z"),
          local_date: "2026-04-16"
        }),
        record({
          dedupe_key: "s4",
          occurred_at: new Date("2026-04-15T10:00:00.000Z"),
          local_date: "2026-04-15"
        })
      ],
      {
        machineId: "mach",
        machineLabel: "Machine",
        codexHomeKind: "default",
        now: new Date("2026-05-15T12:00:00.000Z")
      }
    );

    expect(snapshot.periods.today.total_tokens).toBe(150);
    expect(snapshot.periods.last_7_days.total_tokens).toBe(300);
    expect(snapshot.periods.last_14_days.total_tokens).toBe(450);
    expect(snapshot.periods.last_30_days.total_tokens).toBe(600);
    expect(snapshot.daily).toHaveLength(15);
    expect(snapshot.daily[0]?.date).toBe("2026-05-01");
    expect(snapshot.daily.at(-1)?.date).toBe("2026-05-15");
    expectNoTokenMix(snapshot);
  });

  it("keeps known token totals with partial warning codes", () => {
    const snapshot = buildAggregate(
      [
        record(),
        record({
          dedupe_key: "unknown",
          model: "private-model",
          pricing_known: false,
          priority_tier: "unknown"
        })
      ],
      {
        machineId: "mach",
        machineLabel: "Machine",
        codexHomeKind: "default",
        now: new Date("2026-05-15T12:00:00.000Z")
      }
    );

    expect(snapshot.periods.today.total_tokens).toBe(300);
    expect(snapshot.periods.today.cost_status).toBe("partial");
    expect(snapshot.periods.today.warning_codes).toContain("unknown_pricing");
    expect(snapshot.periods.today.warning_codes).toContain("priority_evidence_missing");
  });

  it("uses observed OpenCode session costs instead of pricing catalog estimates", () => {
    const snapshot = buildAggregate(
      [
        record({
          dedupe_key: "opencode-observed",
          source_provider: "opencode",
          source_kind: "opencode_sqlite",
          model: "claude-sonnet-4.6",
          model_alias: "claude-sonnet-4.6",
          input_tokens: 100,
          cached_input_tokens: 0,
          output_tokens: 50,
          pricing_known: true,
          observed_cost_usd: 0.118197
        } as Partial<SessionUsageRecord>)
      ],
      {
        machineId: "mach",
        machineLabel: "Machine",
        codexHomeKind: "default",
        now: new Date("2026-05-15T12:00:00.000Z")
      }
    );

    expect(snapshot.periods.today.total_tokens).toBe(150);
    expect(snapshot.periods.today.estimated_cost_usd).toBe(0.118197);
    expect(snapshot.periods.today.cost_status).toBe("known");
    expect(snapshot.periods.today.warning_codes).not.toContain("unknown_pricing");
    expect(snapshot.models[0]).toMatchObject({
      name: "claude-sonnet-4.6",
      total_tokens: 150,
      estimated_cost_usd: 0.118197,
      cost_status: "known",
      warning_codes: []
    });
    expect(snapshot.source_summaries?.[0]?.provider).toBe("opencode");
    expect(snapshot.source_summaries?.[0]?.periods.today.estimated_cost_usd).toBe(0.118197);
  });

  it("does not estimate OpenCode costs from the pricing catalog when stored cost is missing", () => {
    const snapshot = buildAggregate(
      [
        record({
          dedupe_key: "opencode-no-cost",
          source_provider: "opencode",
          source_kind: "opencode_sqlite",
          model: "gpt-5",
          model_alias: "gpt-5",
          pricing_known: false
        })
      ],
      {
        machineId: "mach",
        machineLabel: "Machine",
        codexHomeKind: "default",
        now: new Date("2026-05-15T12:00:00.000Z")
      }
    );

    expect(snapshot.periods.today.estimated_cost_usd).toBeNull();
    expect(snapshot.periods.today.cost_status).toBe("unknown");
    expect(snapshot.periods.today.warning_codes).toContain("unknown_pricing");
  });

  it("deduplicates repeated session-turn records", () => {
    const snapshot = buildAggregate([record(), record()], {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "default",
      now: new Date("2026-05-15T12:00:00.000Z")
    });

    expect(snapshot.periods.today.total_tokens).toBe(150);
    expect(snapshot.collector.warnings).toContainEqual({
      code: "duplicate_records_skipped",
      severity: "warning",
      count: 1
    });
  });

  it("builds source summaries while keeping top-level totals combined", () => {
    const snapshot = buildAggregate(
      [
        record(),
        record({
          dedupe_key: "opencode",
          source_provider: "opencode",
          source_kind: "opencode_sqlite",
          model: "gpt-5-mini",
          model_alias: "gpt-5-mini",
          input_tokens: 200,
          cached_input_tokens: 0,
          output_tokens: 80
        }),
        record({
          dedupe_key: "claude",
          source_provider: "claude",
          source_kind: "claude_projects",
          model: "claude-sonnet-4-5",
          model_alias: "claude-sonnet-4-5",
          input_tokens: 200,
          cached_input_tokens: 40,
          output_tokens: 80,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 40
        })
      ],
      {
        machineId: "mach",
        machineLabel: "Machine",
        codexHomeKind: "default",
        now: new Date("2026-05-15T12:00:00.000Z")
      }
    );

    expect(snapshot.periods.today.total_tokens).toBe(770);
    expect(snapshot.source_summaries?.map((summary) => summary.provider)).toEqual([
      "codex",
      "opencode",
      "claude"
    ]);
    expect(snapshot.source_summaries?.map((summary) => summary.periods.today.total_tokens)).toEqual([
      150,
      280,
      340
    ]);
    expect(snapshot.source_summaries?.[1]?.models[0]?.name).toBe("gpt-5-mini");
    expect(snapshot.source_summaries?.[2]?.models[0]).toMatchObject({
      name: "claude-sonnet-4-5",
      total_tokens: 340
    });
    expectNoTokenMix(snapshot.source_summaries);
  });

  it("defaults scans to codex when no provider override is present", async () => {
    const root = await makeTempRoot();
    const opencodeRoot = await makeTempRoot();
    const claudeRoot = await makeTempRoot();
    const opencodeDb = join(opencodeRoot, "opencode.db");
    await writeJsonl(join(root, "sessions", "active.jsonl"), [
      JSON.stringify({
        timestamp: "2026-05-15T10:00:00.000Z",
        session_id: "active",
        model: "gpt-5",
        last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50 }
      })
    ]);
    await createOpenCodeDb(opencodeDb, {
      id: "opencode-session-1",
      time_created: "2026-05-15T11:00:00.000Z",
      model: "openai/gpt-5",
      tokens_input: 120,
      tokens_cache_read: 7,
      tokens_cache_write: 11,
      tokens_output: 40,
      tokens_reasoning: 13
    });
    await writeJsonl(join(claudeRoot, "projects", "project-a", "stream.jsonl"), [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T11:00:00.000Z",
        sessionId: "claude-session-1",
        requestId: "req_stream",
        isSidechain: false,
        message: {
          id: "msg_stream",
          model: "claude-sonnet-4-5-20250929",
          usage: {
            input_tokens: 50,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 2,
            output_tokens: 19
          },
          content: "CANARY_RESPONSE_DO_NOT_UPLOAD"
        }
      })
    ]);

    const result = await scanLocalCostSources(
      loadConfig({
        CODEX_HOME: root,
        TRMNL_TOKEN_METER_OPENCODE_DB: opencodeDb,
        TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: claudeRoot
      })
    );

    expect(result.providerStatuses).toEqual(
      expect.arrayContaining(["codex", "opencode", "claude"].map((provider) => expect.objectContaining({ provider })))
    );

    const sources = result.sources;
    const records = result.records;
    expect(records.map((record) => record.source_provider)).toEqual(["codex"]);
    expect(records[0]?.source_kind).toBe("codex_sessions");
    expect(sources).toContainEqual({ kind: "opencode_sqlite", enabled: false, status: "disabled" });
    expect(sources).toContainEqual({ kind: "claude_projects", enabled: false, status: "disabled" });
  });

  it("parses runtime provider overrides", async () => {
    const root = await makeTempRoot();
    const opencodeRoot = await makeTempRoot();
    const opencodeDb = join(opencodeRoot, "opencode.db");
    await writeJsonl(join(root, "sessions", "active.jsonl"), [
      JSON.stringify({
        timestamp: "2026-05-15T10:00:00.000Z",
        session_id: "active",
        model: "gpt-5",
        last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50 }
      })
    ]);
    await createOpenCodeDb(opencodeDb, {
      id: "opencode-session-1",
      time_created: "2026-05-15T11:00:00.000Z",
      model: "openai/gpt-5",
      tokens_input: 120,
      tokens_cache_read: 7,
      tokens_cache_write: 11,
      tokens_output: 40,
      tokens_reasoning: 13
    });

    const result = await scanLocalCostSources(
      loadConfig({
        CODEX_HOME: root,
        TRMNL_TOKEN_METER_OPENCODE_DB: opencodeDb,
        TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,opencode",
        TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: join(root, "missing-claude")
      })
    );

    expect(result.records.some((record) => record.source_kind === "opencode_sqlite")).toBe(true);
    expect(result.providerStatuses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "codex", status: "available" }),
        expect.objectContaining({ provider: "opencode", status: "available" }),
        expect.objectContaining({ provider: "claude", status: "missing" })
      ])
    );
    const opencodeStatus = result.sources.find((item) => item.kind === "opencode_sqlite");
    expect(opencodeStatus).toMatchObject({
      kind: "opencode_sqlite",
      enabled: true,
      status: "read"
    });
  });
});
