import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectorConfig } from "../config.js";
import { findPricingModel } from "../pricing/index.js";
import type { CollectorWarning, SessionUsageRecord } from "../types.js";
import { warning } from "../warnings.js";
import { localDateKey, type JsonlSourceResult } from "./jsonl.js";

interface ClaudeUsageRow {
  day: string;
  timestamp: Date;
  model: string;
  sessionId: string;
  messageId?: string;
  requestId?: string;
  isSidechain: boolean;
  pathRole: "parent" | "subagent";
  input: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
  output: number;
}

async function discoverJsonlFiles(root: string, output: string[] = []): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await discoverJsonlFiles(path, output);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output.push(path);
    }
  }
  return output;
}

function defaultClaudeProjectRoots(config: CollectorConfig): string[] {
  if (config.claudeProjectsRoots) return config.claudeProjectsRoots;
  return [join(homedir(), ".config", "claude", "projects"), join(homedir(), ".claude", "projects")];
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanField(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return false;
}

function stringLooksVertex(value: string): boolean {
  return value.toLowerCase().includes("vertex");
}

function modelNameLooksVertex(model: string): boolean {
  return model.startsWith("claude-") && model.includes("@");
}

function containsVertexMetadata(value: unknown): boolean {
  if (typeof value === "string") return stringLooksVertex(value);
  if (Array.isArray(value)) return value.some(containsVertexMetadata);
  if (!value || typeof value !== "object") return false;

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes("vertex") || lowerKey.includes("gcp")) return true;
    if (
      ["provider", "source", "platform", "service", "backend"].includes(lowerKey) &&
      typeof item === "string" &&
      stringLooksVertex(item)
    ) {
      return true;
    }
    if (containsVertexMetadata(item)) return true;
  }
  return false;
}

function isVertexAIUsageEntry(object: Record<string, unknown>): boolean {
  const message = objectField(object.message);
  const messageId = stringField(message?.id);
  if (messageId?.includes("_vrtx_")) return true;

  const requestId = stringField(object.requestId);
  if (requestId?.includes("_vrtx_")) return true;

  const model = stringField(message?.model);
  if (model && modelNameLooksVertex(model)) return true;

  return [object, object.metadata, object.request, object.context, object.client, message?.metadata, message?.request].some(
    containsVertexMetadata
  );
}

function normalizeClaudeModel(raw: string): string {
  const priced = findPricingModel(raw);
  if (priced) return priced.id;

  let trimmed = raw.trim();
  if (trimmed.startsWith("anthropic.")) trimmed = trimmed.slice("anthropic.".length);

  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot >= 0 && trimmed.includes("claude-")) {
    const tail = trimmed.slice(lastDot + 1);
    if (tail.startsWith("claude-")) trimmed = tail;
  }

  trimmed = trimmed.replace(/-v\d+:\d+$/, "");
  return trimmed;
}

function pathRole(path: string): ClaudeUsageRow["pathRole"] {
  return path.includes("/subagents/") ? "subagent" : "parent";
}

function parseClaudeLine(line: string, path: string): ClaudeUsageRow | null {
  if (!line.includes("\"type\":\"assistant\"") && !line.includes("\"type\": \"assistant\"")) return null;
  if (!line.includes("\"usage\"")) return null;

  const object = JSON.parse(line) as Record<string, unknown>;
  if (object.type !== "assistant") return null;
  if (isVertexAIUsageEntry(object)) return null;
  const timestampText = stringField(object.timestamp);
  if (!timestampText) return null;
  const timestamp = new Date(timestampText);
  if (Number.isNaN(timestamp.getTime())) return null;

  const message = objectField(object.message);
  const usage = objectField(message?.usage);
  const model = stringField(message?.model);
  if (!message || !usage || !model) return null;

  const input = numberField(usage.input_tokens);
  const cacheCreation = numberField(usage.cache_creation_input_tokens);
  // Claude Code splits cache writes by TTL and bills the 1-hour ones at twice the
  // input rate. Clamp to the lane total so a malformed record cannot bill more
  // cache creation than the message actually reported.
  const cacheCreation1h = Math.min(
    cacheCreation,
    numberField(objectField(usage.cache_creation)?.ephemeral_1h_input_tokens)
  );
  const cacheRead = numberField(usage.cache_read_input_tokens);
  const output = numberField(usage.output_tokens);
  if (input === 0 && cacheCreation === 0 && cacheRead === 0 && output === 0) return null;

  const messageId = stringField(message.id);
  const requestId = stringField(object.requestId);
  return {
    day: localDateKey(timestamp),
    timestamp,
    model: normalizeClaudeModel(model),
    sessionId:
      stringField(object.sessionId) ??
      stringField(object.session_id) ??
      stringField(objectField(object.metadata)?.sessionId) ??
      stringField(objectField(message.metadata)?.sessionId) ??
      "unknown",
    ...(messageId ? { messageId } : {}),
    ...(requestId ? { requestId } : {}),
    isSidechain: booleanField(object.isSidechain),
    pathRole: pathRole(path),
    input,
    cacheRead,
    cacheCreation,
    cacheCreation1h,
    output
  };
}

function inFileKey(row: ClaudeUsageRow): string | null {
  return row.messageId && row.requestId ? `${row.messageId}:${row.requestId}` : null;
}

function candidateWins(candidate: { path: string; row: ClaudeUsageRow }, existing: { path: string; row: ClaudeUsageRow }): boolean {
  if (candidate.row.isSidechain !== existing.row.isSidechain) return existing.row.isSidechain;
  if (candidate.row.pathRole !== existing.row.pathRole) return existing.row.pathRole === "subagent";
  return candidate.path < existing.path;
}

function recordFromClaudeRow(row: ClaudeUsageRow): SessionUsageRecord {
  const canonical = inFileKey(row);
  return {
    dedupe_key: canonical
      ? `claude:${canonical}`
      : `claude:${row.sessionId}:${row.timestamp.toISOString()}:${row.model}:${row.input}:${row.cacheRead}:${row.cacheCreation}:${row.output}`,
    source_provider: "claude",
    source_kind: "claude_projects",
    occurred_at: row.timestamp,
    local_date: row.day,
    model: row.model,
    model_alias: row.model,
    input_tokens: row.input,
    cached_input_tokens: row.cacheRead,
    output_tokens: row.output,
    cache_creation_input_tokens: row.cacheCreation,
    cache_creation_1h_input_tokens: row.cacheCreation1h,
    cache_read_input_tokens: row.cacheRead,
    long_context: false,
    priority_tier: "base",
    pricing_known: findPricingModel(row.model) !== null
  };
}

export async function readClaudeProjectSource(config: CollectorConfig): Promise<JsonlSourceResult> {
  const files: string[] = [];
  for (const root of defaultClaudeProjectRoots(config)) {
    try {
      files.push(...(await discoverJsonlFiles(root)));
    } catch {
      continue;
    }
  }

  if (files.length === 0) {
    return {
      records: [],
      warnings: [],
      status: { kind: "claude_projects", enabled: true, status: "missing" }
    };
  }

  const keyedRows = new Map<string, { path: string; row: ClaudeUsageRow }>();
  const unkeyedRows: ClaudeUsageRow[] = [];
  let malformed = 0;

  for (const file of [...new Set(files)].sort()) {
    try {
      if (!(await stat(file)).isFile()) continue;
      const fileKeyedRows = new Map<string, ClaudeUsageRow>();
      const fileUnkeyedRows: ClaudeUsageRow[] = [];
      for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const row = parseClaudeLine(line, file);
          if (!row) continue;
          const key = inFileKey(row);
          if (key) {
            fileKeyedRows.set(key, row);
          } else {
            fileUnkeyedRows.push(row);
          }
        } catch {
          malformed += 1;
        }
      }

      for (const [key, row] of fileKeyedRows) {
        const candidate = { path: file, row };
        const existing = keyedRows.get(key);
        if (!existing || candidateWins(candidate, existing)) keyedRows.set(key, candidate);
      }
      unkeyedRows.push(...fileUnkeyedRows);
    } catch {
      malformed += 1;
    }
  }

  const rows = [...keyedRows.values()].map((value) => value.row).concat(unkeyedRows);
  const warnings: CollectorWarning[] = malformed > 0 ? [warning("malformed_records_skipped", malformed)] : [];
  return {
    records: rows.map(recordFromClaudeRow),
    warnings,
    status: {
      kind: "claude_projects",
      enabled: true,
      status: malformed > 0 && rows.length === 0 ? "malformed" : "read",
      record_count: rows.length,
      ...(malformed > 0 ? { warning_code: "malformed_records_skipped" } : {})
    }
  };
}
