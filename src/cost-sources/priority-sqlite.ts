import { access } from "node:fs/promises";
import { join } from "node:path";
import type { CollectorConfig } from "../config.js";
import type { CollectorWarning, LocalUsageSourceStatus, PriorityTierEvidence } from "../types.js";
import { warning } from "../warnings.js";

export interface PriorityEvidenceResult {
  evidence: PriorityTierEvidence[];
  warnings: CollectorWarning[];
  status: LocalUsageSourceStatus;
}

type SqliteRow = Record<string, unknown>;

type DatabaseSyncConstructor = new (
  path: string,
  options?: { open?: boolean; readOnly?: boolean }
) => {
  prepare(sql: string): { all(): SqliteRow[] };
  close(): void;
};

const importSqlite = async (): Promise<{ DatabaseSync: DatabaseSyncConstructor }> => {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
  ) => Promise<{ DatabaseSync: DatabaseSyncConstructor }>;
  return dynamicImport("node:sqlite");
};

const stringValue = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

const tierValue = (value: unknown): "base" | "priority" | "unknown" => {
  const text = stringValue(value)?.toLowerCase();
  if (text === "priority" || text === "premium" || text === "high") return "priority";
  if (text === "base" || text === "standard") return "base";
  return "unknown";
};

function evidenceFromRows(rows: SqliteRow[]): PriorityTierEvidence[] {
  const evidence: PriorityTierEvidence[] = [];
  for (const row of rows) {
    const matchKey =
      stringValue(row.match_key) ??
      stringValue(row.dedupe_key) ??
      stringValue(row.session_id) ??
      stringValue(row.sessionId);
    if (!matchKey) continue;
    evidence.push({
      match_key: matchKey,
      tier: tierValue(row.tier ?? row.priority_tier ?? row.priorityTier ?? row.service_tier),
      confidence: row.match_key || row.dedupe_key ? "exact" : "inferred"
    });
  }
  return evidence;
}

async function readEvidenceRows(sqlitePath: string): Promise<PriorityTierEvidence[]> {
  const { DatabaseSync } = await importSqlite();
  const database = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const tables = database
      .prepare("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => stringValue(row.name))
      .filter((name): name is string => Boolean(name));
    const evidence: PriorityTierEvidence[] = [];
    for (const table of tables) {
      const safeTable = table.replace(/"/g, "\"\"");
      const rows = database.prepare(`select * from "${safeTable}" limit 5000`).all();
      evidence.push(...evidenceFromRows(rows));
    }
    return evidence;
  } finally {
    database.close();
  }
}

export async function readPriorityEvidence(config: CollectorConfig): Promise<PriorityEvidenceResult> {
  const sqlitePath = join(config.codexHome, "logs_2.sqlite");
  try {
    await access(sqlitePath);
  } catch (error) {
    const code =
      (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "priority_evidence_missing"
        : "priority_evidence_unreadable";
    return {
      evidence: [],
      warnings: [warning(code)],
      status: { kind: "codex_priority_sqlite", enabled: true, status: "missing", warning_code: code }
    };
  }

  try {
    const evidence = await readEvidenceRows(sqlitePath);
    return {
      evidence,
      warnings: [],
      status: {
        kind: "codex_priority_sqlite",
        enabled: true,
        status: "read",
        record_count: evidence.length
      }
    };
  } catch {
    return {
      evidence: [],
      warnings: [warning("priority_evidence_malformed")],
      status: {
        kind: "codex_priority_sqlite",
        enabled: true,
        status: "malformed",
        warning_code: "priority_evidence_malformed"
      }
    };
  }
}
