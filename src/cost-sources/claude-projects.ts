import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CollectorConfig } from "../config.js";
import { findPricingModel } from "../pricing/index.js";
import type { CollectorWarning, SessionUsageRecord } from "../types.js";
import { warning } from "../warnings.js";
import { claudeProjectRoots } from "./claude-roots.js";
import { localDateKey, type JsonlSourceResult } from "./jsonl.js";

interface ClaudeUsageRow {
  day: string;
  timestamp: Date;
  model: string;
  sessionId: string;
  /** Session id as recorded; absent when the row carried none. */
  recordedSessionId?: string;
  messageId?: string;
  requestId?: string;
  isSidechain: boolean;
  pathRole: "parent" | "subagent";
  input: number;
  cacheRead: number;
  cacheCreation: number;
  cacheCreation1h: number;
  output: number;
  /**
   * A proxy's cache-unaware `message_start` estimate: `stop_reason: null`, input
   * but no output, and no cache lanes at all. It never counts, and never displaces
   * a complete row for the same request.
   */
  incomplete: boolean;
}

const isJsonlName = (name: string): boolean => name.toLowerCase().endsWith(".jsonl");

async function discoverJsonlFiles(root: string, output: string[] = []): Promise<string[]> {
  // A root may itself be a transcript file (Cowork `audit.jsonl`).
  if ((await stat(root)).isFile()) {
    if (isJsonlName(root)) output.push(root);
    return output;
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await discoverJsonlFiles(path, output);
    } else if ((entry.isFile() || entry.isSymbolicLink()) && isJsonlName(entry.name)) {
      // Symlinked transcripts count like CodexBar's; the read loop skips any
      // link that does not resolve to a regular file.
      output.push(path);
    }
  }
  return output;
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

const vertexProviderKeys = new Set([
  "provider",
  "platform",
  "backend",
  "api_provider",
  "apiprovider",
  "api_type",
  "apitype",
  "source",
  "vendor",
  "client"
]);

function stringLooksVertex(value: string): boolean {
  return value.toLowerCase().includes("vertex");
}

function modelNameLooksVertex(model: string): boolean {
  return model.startsWith("claude-") && model.includes("@");
}

// Matches CodexBar: a Vertex marker in any key, or "vertex" in the string value of
// a provider-like key. Free-text values (message content, tool output) are never
// inspected, so a transcript that merely mentions Vertex still counts. Arrays
// descend into objects only.
function containsVertexMetadata(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => isPlainObject(item) && containsVertexMetadata(item));
  if (!isPlainObject(value)) return false;

  for (const [key, item] of Object.entries(value)) {
    const lowerKey = key.toLowerCase();
    if (lowerKey.includes("vertex") || lowerKey.includes("gcp")) return true;
    if (vertexProviderKeys.has(lowerKey) && typeof item === "string" && stringLooksVertex(item)) {
      return true;
    }
    if ((Array.isArray(item) || isPlainObject(item)) && containsVertexMetadata(item)) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const requestIdOf = (object: Record<string, unknown>): string | undefined =>
  stringField(object.requestId) ?? stringField(object.request_id);

function isVertexAIUsageEntry(object: Record<string, unknown>): boolean {
  const message = objectField(object.message);
  const messageId = stringField(message?.id);
  if (messageId?.includes("_vrtx_")) return true;

  const requestId = stringField(object.requestId);
  if (requestId?.includes("_vrtx_")) return true;

  const model = stringField(message?.model);
  if (model && modelNameLooksVertex(model)) return true;

  // The walk from the root already reaches metadata, request, context, and client.
  return containsVertexMetadata(object);
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
  // Cowork audit rows spell it `request_id`; the same message in the embedded
  // transcript uses `requestId`. Reading both makes them one request.
  const requestId = requestIdOf(object);
  const recordedSessionId =
    stringField(object.sessionId) ??
    stringField(object.session_id) ??
    stringField(objectField(object.metadata)?.sessionId) ??
    stringField(objectField(message.metadata)?.sessionId);
  const incomplete =
    "stop_reason" in message &&
    message.stop_reason === null &&
    input > 0 &&
    output === 0 &&
    !("cache_read_input_tokens" in usage) &&
    !("cache_creation_input_tokens" in usage);
  return {
    day: localDateKey(timestamp),
    timestamp,
    model: normalizeClaudeModel(model),
    sessionId: recordedSessionId ?? "unknown",
    ...(recordedSessionId ? { recordedSessionId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(requestId ? { requestId } : {}),
    isSidechain: booleanField(object.isSidechain),
    pathRole: pathRole(path),
    input,
    cacheRead,
    cacheCreation,
    cacheCreation1h,
    output,
    incomplete
  };
}

/**
 * Request identity, as in CodexBar: message + request id when both exist,
 * otherwise session + message id so a proxy's repeated snapshots of one message
 * count once. The two key spaces never collide. Rows with neither stay unkeyed.
 */
function inFileKey(row: ClaudeUsageRow): string | null {
  if (row.messageId && row.requestId) return `${row.messageId}:${row.requestId}`;
  if (row.messageId && row.recordedSessionId) return `session:${row.recordedSessionId}:${row.messageId}`;
  return null;
}

/** Within one file the last row wins, except that an incomplete row never replaces a complete one. */
function inFileCandidateWins(candidate: ClaudeUsageRow, existing: ClaudeUsageRow): boolean {
  return !candidate.incomplete || existing.incomplete;
}

function candidateWins(candidate: { path: string; row: ClaudeUsageRow }, existing: { path: string; row: ClaudeUsageRow }): boolean {
  if (candidate.row.incomplete !== existing.row.incomplete) return existing.row.incomplete;
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
  for (const root of await claudeProjectRoots(config)) {
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
            const existing = fileKeyedRows.get(key);
            if (!existing || inFileCandidateWins(row, existing)) fileKeyedRows.set(key, row);
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

  const rows = [...keyedRows.values()]
    .map((value) => value.row)
    .concat(unkeyedRows)
    .filter((row) => !row.incomplete);
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
