import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { CollectorConfig } from "../config.js";
import { findPricingModel } from "../pricing/index.js";
import type { CollectorWarning, LocalUsageSourceStatus, SessionUsageRecord } from "../types.js";
import { localDateKey, type JsonlSourceResult } from "./jsonl.js";

interface OpenCodeSqliteResult extends JsonlSourceResult {
  records: SessionUsageRecord[];
  warnings: CollectorWarning[];
  status: LocalUsageSourceStatus;
}

interface OpenCodeSessionRow {
  id: unknown;
  time_created: unknown;
  model: unknown;
  tokens_input: unknown;
  tokens_cache_read: unknown;
  tokens_cache_write: unknown;
  tokens_output: unknown;
  tokens_reasoning: unknown;
  cost: unknown;
}

type DatabaseSyncConstructor = new (
  path: string,
  options?: { open?: boolean; readOnly?: boolean }
) => {
  prepare(sql: string): { all(): Record<string, unknown>[] };
  close(): void;
};

const importSqlite = async (): Promise<{ DatabaseSync: DatabaseSyncConstructor }> => {
  return import("node:sqlite");
};

type OpenCodeWarningCode =
  | "opencode_sqlite_missing"
  | "opencode_sqlite_unreadable"
  | "opencode_sqlite_malformed";

const sourceWarning = (code: OpenCodeWarningCode): CollectorWarning => ({
  code,
  severity: "warning"
});

const numberValue = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

const costValue = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const dateValue = (value: unknown): Date | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value > 10_000_000_000 ? value : value * 1000);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const text = stringValue(value);
  if (!text) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
};

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function modelCandidateFromJson(raw: string): string | null {
  try {
    const object = objectValue(JSON.parse(raw));
    if (!object) return null;
    return (
      stringValue(object.modelID) ??
      stringValue(object.modelId) ??
      stringValue(object.model_id) ??
      stringValue(object.id) ??
      stringValue(object.model)
    );
  } catch {
    return null;
  }
}

function normalizeOpenCodeModel(raw: unknown): string {
  const text = stringValue(raw);
  if (!text) return "unknown";
  const candidate = modelCandidateFromJson(text) ?? text;
  const withoutProvider = candidate.includes("/") ? candidate.split("/").at(-1) ?? candidate : candidate;
  const priced = findPricingModel(withoutProvider);
  if (priced) return priced.id;
  const normalized = withoutProvider.trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9._:-]+$/.test(normalized) ? normalized : "unknown";
}

function recordFromRow(row: OpenCodeSessionRow): SessionUsageRecord | null {
  const id = stringValue(row.id);
  const occurredAt = dateValue(row.time_created);
  if (!id || !occurredAt) return null;

  const input = numberValue(row.tokens_input);
  const cacheRead = numberValue(row.tokens_cache_read);
  const cacheWrite = numberValue(row.tokens_cache_write);
  const output = numberValue(row.tokens_output);
  const reasoning = numberValue(row.tokens_reasoning);
  const observedCost = costValue(row.cost);
  if (input === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0 && reasoning === 0) return null;

  const model = normalizeOpenCodeModel(row.model);
  return {
    dedupe_key: `opencode:${id}`,
    source_provider: "opencode",
    source_kind: "opencode_sqlite",
    occurred_at: occurredAt,
    local_date: localDateKey(occurredAt),
    model,
    model_alias: model,
    ...(observedCost !== null ? { observed_cost_usd: observedCost } : {}),
    input_tokens: input,
    cached_input_tokens: cacheRead,
    output_tokens: output + reasoning,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    long_context: false,
    priority_tier: "base",
    pricing_known: observedCost !== null
  };
}

async function readRows(sqlitePath: string): Promise<SessionUsageRecord[]> {
  const { DatabaseSync } = await importSqlite();
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const rows = database
      .prepare(`
        select
          id,
          time_created,
          model,
          tokens_input,
          tokens_cache_read,
          tokens_cache_write,
          tokens_output,
          tokens_reasoning,
          cost
        from session
      `)
      .all();
    return rows.flatMap((row) => {
      const record = recordFromRow(row as unknown as OpenCodeSessionRow);
      return record ? [record] : [];
    });
  } finally {
    database.close();
  }
}

export async function readOpenCodeSqliteSource(
  config: CollectorConfig
): Promise<OpenCodeSqliteResult> {
  try {
    await access(config.opencodeDbPath, constants.R_OK);
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "opencode_sqlite_missing"
        : "opencode_sqlite_unreadable";
    return {
      records: [],
      warnings: [sourceWarning(code)],
      status: {
        kind: "opencode_sqlite",
        enabled: true,
        status: code === "opencode_sqlite_missing" ? "missing" : "unreadable",
        warning_code: code
      }
    };
  }

  try {
    const records = await readRows(config.opencodeDbPath);
    return {
      records,
      warnings: [],
      status: {
        kind: "opencode_sqlite",
        enabled: true,
        status: "read",
        record_count: records.length
      }
    };
  } catch {
    return {
      records: [],
      warnings: [sourceWarning("opencode_sqlite_malformed")],
      status: {
        kind: "opencode_sqlite",
        enabled: true,
        status: "malformed",
        warning_code: "opencode_sqlite_malformed"
      }
    };
  }
}
