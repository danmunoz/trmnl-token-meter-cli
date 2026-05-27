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
  return import("node:sqlite");
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

const valueFromPrefix = (name: string, text: string): string | null => {
  const index = text.indexOf(`${name}=`);
  if (index < 0) return null;
  const tail = text.slice(index + name.length + 1);
  const value = tail.match(/^[^\s,\])]+/)?.[0];
  return value && value.trim() ? value : null;
};

type TraceEvidence = {
  turnId: string;
  tier?: "priority";
  model?: string;
};

function jsonAfterMarker(body: string, marker: string): { prefix: string; object: Record<string, unknown> } | null {
  const markerIndex = body.indexOf(marker);
  if (markerIndex < 0) return null;

  const prefix = body.slice(0, markerIndex);
  const jsonText = body.slice(markerIndex + marker.length).trim();
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return { prefix, object: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

function priorityTraceFromBody(body: string): TraceEvidence | null {
  const parsed = jsonAfterMarker(body, "websocket request:");
  if (!parsed) return null;
  const request = parsed.object;
  if (request.type !== "response.create" || request.service_tier !== "priority") return null;
  const turnId =
    valueFromPrefix("turn.id", parsed.prefix) ??
    valueFromPrefix("turn_id", parsed.prefix) ??
    stringValue(request.turn_id) ??
    stringValue(request.turnId);
  if (!turnId) return null;

  const model = stringValue(request.model);
  return {
    turnId,
    tier: "priority",
    ...(model ? { model } : {})
  };
}

function completedTraceFromBody(body: string): TraceEvidence | null {
  const parsed = jsonAfterMarker(body, "websocket event:");
  if (!parsed) return null;
  const event = parsed.object;
  if (event.type !== "response.completed") return null;
  const response = event.response;
  if (!response || typeof response !== "object") return null;
  const model = stringValue((response as Record<string, unknown>).model);
  const turnId = valueFromPrefix("turn.id", parsed.prefix) ?? valueFromPrefix("turn_id", parsed.prefix);
  if (!turnId || !model) return null;
  return { turnId, model };
}

function traceEvidenceFromRows(rows: SqliteRow[]): PriorityTierEvidence[] {
  const byTurnId = new Map<string, TraceEvidence>();
  for (const row of rows) {
    const body = stringValue(row.feedback_log_body);
    if (!body) continue;
    const parsed = priorityTraceFromBody(body) ?? completedTraceFromBody(body);
    if (!parsed) continue;
    const existing = byTurnId.get(parsed.turnId);
    const tier = parsed.tier ?? existing?.tier;
    const model = parsed.model ?? existing?.model;
    byTurnId.set(parsed.turnId, {
      turnId: parsed.turnId,
      ...(tier ? { tier } : {}),
      ...(model ? { model } : {})
    });
  }

  return [...byTurnId.values()].flatMap((item) =>
    item.tier === "priority"
      ? [
          {
            match_key: item.turnId,
            tier: "priority" as const,
            confidence: "exact" as const,
            ...(item.model ? { model: item.model } : {})
          }
        ]
      : []
  );
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
      if (table === "logs") {
        const rows = database
          .prepare(
            `select feedback_log_body from "${safeTable}" where feedback_log_body like '%websocket request:%' or feedback_log_body like '%response.completed%'`
          )
          .all();
        evidence.push(...traceEvidenceFromRows(rows));
        continue;
      }

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
