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

// OpenCode records usage per assistant message in the `message` table. Each row
// carries a JSON `data` blob with the model, per-turn token counts, and cost.
// We attribute usage to the message timestamp — not the session's creation date —
// because OpenCode sessions are long-lived and reused across many days, and older
// sessions leave the session-level rollup columns empty.
interface OpenCodeMessageRow {
  id: unknown;
  time_created: unknown;
  data: unknown;
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

const parseJsonObject = (raw: unknown): Record<string, unknown> | null => {
  const text = stringValue(raw);
  if (!text) return objectValue(raw);
  try {
    return objectValue(JSON.parse(text));
  } catch {
    return null;
  }
};

function normalizeOpenCodeModel(raw: unknown): string {
  const candidate = stringValue(raw);
  if (!candidate) return "unknown";
  const withoutProvider = candidate.includes("/") ? candidate.split("/").at(-1) ?? candidate : candidate;
  const priced = findPricingModel(withoutProvider);
  if (priced) return priced.id;
  const normalized = withoutProvider.trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9._:-]+$/.test(normalized) ? normalized : "unknown";
}

// Only the fields below are ever read out of the message blob. Raw prompt/response
// text, file paths, titles, and other context stay local and never reach a record.
function recordFromMessage(row: OpenCodeMessageRow): SessionUsageRecord | null {
  const id = stringValue(row.id);
  const data = parseJsonObject(row.data);
  if (!id || !data) return null;
  if (stringValue(data.role) !== "assistant") return null;

  const tokens = objectValue(data.tokens);
  if (!tokens) return null;
  const cache = objectValue(tokens.cache) ?? {};

  const input = numberValue(tokens.input);
  const cacheRead = numberValue(cache.read);
  const cacheWrite = numberValue(cache.write);
  const output = numberValue(tokens.output);
  const reasoning = numberValue(tokens.reasoning);
  if (input === 0 && cacheRead === 0 && cacheWrite === 0 && output === 0 && reasoning === 0) return null;

  const occurredAt = dateValue(row.time_created) ?? dateValue(objectValue(data.time)?.created);
  if (!occurredAt) return null;

  const observedCost = costValue(data.cost);
  const model = normalizeOpenCodeModel(data.modelID ?? data.model);
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
    const hasMessageTable =
      database
        .prepare("select name from sqlite_master where type = 'table' and name = 'message'")
        .all().length > 0;
    if (!hasMessageTable) {
      throw new Error("opencode schema missing message table");
    }
    const rows = database.prepare("select id, time_created, data from message").all();
    return rows.flatMap((row) => {
      const record = recordFromMessage(row as unknown as OpenCodeMessageRow);
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
