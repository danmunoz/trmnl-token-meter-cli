import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { applyForkLedger, forkWarnings } from "../forks.js";
import {
  mergeTokenUsageContext,
  normalizeTokenUsageRecord,
  type TokenUsageContext
} from "../token-usage.js";
import type {
  CollectorWarning,
  LocalUsageSourceKind,
  LocalUsageSourceStatus,
  SourceProvider,
  SessionUsageRecord,
  UsageEvent,
  WarningCode
} from "../types.js";
import { warning } from "../warnings.js";
import { CodexLedgerCollector, mergeLedgerRows } from "./codex-ledger.js";

export interface JsonlSourceResult {
  records: SessionUsageRecord[];
  warnings: CollectorWarning[];
  status: LocalUsageSourceStatus;
}

export const localDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

export const nextLocalDate = (date: string, days = 1): string => {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  value.setDate(value.getDate() + days);
  return localDateKey(value);
};

const compressedSuffix = ".zst";

/**
 * Codex compresses cold rollouts in place (`X.jsonl` -> `X.jsonl.zst`). CodexBar
 * keeps the usage it parsed while the file was plain; this collector is stateless,
 * so it reads the archive instead. A plain file always wins over its archive.
 */
async function discoverJsonlFiles(dir: string, output: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    const name = entry.name.toLowerCase();
    if (entry.isDirectory()) {
      await discoverJsonlFiles(path, output);
    } else if (!entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    } else if (name.endsWith(".jsonl")) {
      output.push(path);
    } else if (
      name.endsWith(`.jsonl${compressedSuffix}`) &&
      !names.has(entry.name.slice(0, -compressedSuffix.length)) &&
      zstdDecompress
    ) {
      output.push(path);
    }
  }
  return output;
}

// `zstdDecompressSync` ships in Node 22.15+/23.8+. Older runtimes skip archives.
const zstdDecompress = (zlib as { zstdDecompressSync?: (input: Buffer) => Buffer }).zstdDecompressSync;

const readJsonlText = async (file: string): Promise<string> => {
  if (!file.toLowerCase().endsWith(compressedSuffix)) return readFile(file, "utf8");
  if (!zstdDecompress) return "";
  return zstdDecompress(await readFile(file)).toString("utf8");
};

const eventDedupeKey = (event: UsageEvent): string =>
  // A ledger row is identified by its response, like CodexBar's request identity.
  event.response_id
    ? `${event.session_id}:response:${event.response_id}`
    : [
        event.session_id,
        event.turn_id ?? "",
        event.timestamp.toISOString(),
        event.model,
        event.input_tokens,
        event.cached_input_tokens,
        event.output_tokens
      ].join(":");

export const recordFromEvent = (
  event: UsageEvent,
  sourceKind: LocalUsageSourceKind,
  sourceProvider: SourceProvider = "codex"
): SessionUsageRecord => ({
  dedupe_key: eventDedupeKey(event),
  source_provider: sourceProvider,
  source_kind: sourceKind,
  occurred_at: event.timestamp,
  local_date: localDateKey(event.timestamp),
  model: event.model,
  model_alias: event.model,
  ...(event.turn_id ? { turn_id: event.turn_id } : {}),
  input_tokens: event.input_tokens,
  cached_input_tokens: event.cached_input_tokens,
  output_tokens: event.output_tokens,
  long_context: event.long_context ?? false,
  priority_tier: event.priority_tier ?? "base",
  pricing_known: event.model !== "unknown"
});

interface UsageTotals {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

interface UsageSnapshot {
  timestamp: Date;
  totals: UsageTotals;
}

interface ParsedUsageFile {
  events: UsageEvent[];
  ledger: CodexLedgerCollector;
  sessionId?: string;
  parentId?: string;
  forkTimestamp?: string;
  snapshots: UsageSnapshot[];
  ownedSuffixBaseline?: UsageTotals;
}

function addTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    input_tokens: left.input_tokens + right.input_tokens,
    cached_input_tokens: left.cached_input_tokens + right.cached_input_tokens,
    output_tokens: left.output_tokens + right.output_tokens
  };
}

function subtractTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    input_tokens: Math.max(0, left.input_tokens - right.input_tokens),
    cached_input_tokens: Math.max(0, left.cached_input_tokens - right.cached_input_tokens),
    output_tokens: Math.max(0, left.output_tokens - right.output_tokens)
  };
}

function totalsFromEvent(event: UsageEvent): UsageTotals {
  return {
    input_tokens: event.input_tokens,
    cached_input_tokens: event.cached_input_tokens,
    output_tokens: event.output_tokens
  };
}

function hasUsage(event: UsageEvent): boolean {
  return event.input_tokens > 0 || event.cached_input_tokens > 0 || event.output_tokens > 0;
}

function totalsEqual(left: UsageTotals, right: UsageTotals): boolean {
  return (
    left.input_tokens === right.input_tokens &&
    left.cached_input_tokens === right.cached_input_tokens &&
    left.output_tokens === right.output_tokens
  );
}

function totalsAtLeast(left: UsageTotals, right: UsageTotals): boolean {
  return (
    left.input_tokens >= right.input_tokens &&
    left.cached_input_tokens >= right.cached_input_tokens &&
    left.output_tokens >= right.output_tokens
  );
}

interface SubagentOwnedSuffix {
  startLine: number;
  explicitHistoryBoundary: boolean;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSubagentPayload(payload: Record<string, unknown> | undefined): boolean {
  const source = payload?.source;
  const nestedSubagent =
    source && typeof source === "object"
      ? (source as Record<string, unknown>).subagent
      : undefined;
  return (
    stringValue(payload?.thread_source ?? payload?.threadSource ?? source)?.toLowerCase() ===
      "subagent" ||
    typeof nestedSubagent === "string" ||
    (nestedSubagent !== null && typeof nestedSubagent === "object")
  );
}

function parentIdFromPayload(payload: Record<string, unknown> | undefined): string | undefined {
  return stringValue(
    payload?.forked_from_id ??
      payload?.forkedFromId ??
      payload?.parent_session_id ??
      payload?.parentSessionId ??
      payload?.parent_id ??
      payload?.parentId
  );
}

function subagentOwnedSuffix(
  records: readonly Record<string, unknown>[],
  eventsByLine: readonly { event: UsageEvent; line: number }[]
): SubagentOwnedSuffix | undefined {
  const firstMetadata = records.find((record) => record.type === "session_meta");
  const firstPayload = firstMetadata?.payload as Record<string, unknown> | undefined;
  const leafId = stringValue(firstPayload?.id);
  if (!isSubagentPayload(firstPayload) || !leafId) return undefined;

  const leafPayloads = records
    .filter((record) => record.type === "session_meta")
    .map((record) => record.payload as Record<string, unknown> | undefined)
    .filter((payload) => stringValue(payload?.id) === leafId);

  const historyStartOrdinal = leafPayloads
    .map((payload) => payload?.subagent_history_start_ordinal)
    .find((value) => typeof value === "number" && Number.isInteger(value));
  if (typeof historyStartOrdinal === "number" && Number.isInteger(historyStartOrdinal)) {
    const startIndex = records.findIndex(
      (record) => typeof record.ordinal === "number" && record.ordinal >= historyStartOrdinal
    );
    if (startIndex >= 0) return { startLine: startIndex + 1, explicitHistoryBoundary: true };
  }

  let lastEmbeddedMetadataLine = -1;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record?.type !== "session_meta") continue;
    const payload = record.payload as Record<string, unknown> | undefined;
    const id = stringValue(payload?.id);
    if (id && id !== leafId) lastEmbeddedMetadataLine = index + 1;
  }
  const parentId = leafPayloads.map(parentIdFromPayload).find((value) => value !== undefined);
  const boundarySearchStart = lastEmbeddedMetadataLine >= 0 ? lastEmbeddedMetadataLine : 0;
  for (let index = boundarySearchStart; index < records.length - 1; index += 1) {
    const turnContext = records[index];
    const communication = records[index + 1];
    const payload = communication?.payload as Record<string, unknown> | undefined;
    if (
      turnContext?.type === "turn_context" &&
      communication?.type === "inter_agent_communication_metadata" &&
      payload?.trigger_turn === true
    ) {
      const startLine = index + 1;
      if (lastEmbeddedMetadataLine >= 0) {
        return { startLine, explicitHistoryBoundary: false };
      }
      if (!parentId) return undefined;

      const baselineEvent = [...eventsByLine].reverse().find(
        (item) => item.line < startLine && item.event.cumulative_usage
      )?.event;
      const firstOwnedEvent = eventsByLine.find(
        (item) => item.line >= startLine && item.event.cumulative_usage
      )?.event;
      const baseline = baselineEvent?.cumulative_usage;
      const total = firstOwnedEvent?.cumulative_usage;
      if (!baseline || !total || firstOwnedEvent.record_kind !== "delta") return undefined;
      const last = totalsFromEvent(firstOwnedEvent);
      if (totalsAtLeast(total, last) && totalsEqual(subtractTotals(total, last), baseline)) {
        return { startLine, explicitHistoryBoundary: false };
      }
      if (totalsEqual(total, last) && !totalsAtLeast(total, baseline)) {
        return { startLine, explicitHistoryBoundary: false };
      }
      return undefined;
    }
    if (lastEmbeddedMetadataLine < 0 && turnContext?.type === "turn_context") return undefined;
  }
  return undefined;
}

function hasCopiedCumulativePrefix(events: readonly UsageEvent[], inherited: UsageTotals): boolean {
  const firstCumulative = events.find(
    (event) => event.cumulative_usage || event.record_kind === "cumulative"
  );
  if (!firstCumulative) return false;
  const totals = firstCumulative.cumulative_usage ?? totalsFromEvent(firstCumulative);
  return (
    totals.input_tokens >= inherited.input_tokens &&
    totals.cached_input_tokens >= inherited.cached_input_tokens &&
    totals.output_tokens >= inherited.output_tokens
  );
}

function snapshotsFromEvents(events: readonly UsageEvent[]): UsageSnapshot[] {
  const snapshots: UsageSnapshot[] = [];
  let current: UsageTotals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  for (const event of applyForkLedger([...events]).events) {
    current = addTotals(current, totalsFromEvent(event));
    snapshots.push({ timestamp: event.timestamp, totals: current });
  }
  return snapshots;
}

function inheritedTotalsAt(
  snapshots: readonly UsageSnapshot[] | undefined,
  forkTimestamp: string | undefined
): UsageTotals | undefined {
  if (!snapshots?.length || !forkTimestamp) return undefined;
  const forkDate = new Date(forkTimestamp);
  const forkTime = Number.isNaN(forkDate.getTime()) ? undefined : forkDate.getTime();
  let inherited: UsageTotals | undefined;
  for (const snapshot of snapshots) {
    if (
      forkTime === undefined
        ? snapshot.timestamp.toISOString() <= forkTimestamp
        : snapshot.timestamp.getTime() <= forkTime
    ) {
      inherited = snapshot.totals;
    }
  }
  return inherited;
}

function applyInheritedTotals(
  events: readonly UsageEvent[],
  inherited: UsageTotals | undefined
): UsageEvent[] {
  if (!inherited || !hasCopiedCumulativePrefix(events, inherited)) return [...events];
  let remaining: UsageTotals | undefined = inherited;
  return events.map((event) => {
    const cumulative =
      event.cumulative_usage ?? (event.record_kind === "cumulative" ? totalsFromEvent(event) : undefined);
    if (cumulative) {
      remaining = undefined;
      const adjusted = subtractTotals(cumulative, inherited);
      return {
        ...event,
        ...adjusted,
        cumulative_usage: adjusted,
        record_kind: "cumulative"
      };
    }
    if (!remaining) return event;

    const adjusted = subtractTotals(totalsFromEvent(event), remaining);
    remaining = subtractTotals(remaining, totalsFromEvent(event));
    if (
      remaining.input_tokens === 0 &&
      remaining.cached_input_tokens === 0 &&
      remaining.output_tokens === 0
    ) {
      remaining = undefined;
    }
    return { ...event, ...adjusted };
  });
}

export async function readJsonlUsageSource(
  root: string,
  kind: LocalUsageSourceKind,
  missingCode: WarningCode,
  malformedCode: WarningCode = "malformed_records_skipped"
): Promise<JsonlSourceResult> {
  let files: string[];
  try {
    files = (await discoverJsonlFiles(root)).sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? missingCode : malformedCode;
    return {
      records: [],
      warnings: [warning(code)],
      status: { kind, enabled: true, status: code === missingCode ? "missing" : "unreadable", warning_code: code }
    };
  }

  const parsedFiles: ParsedUsageFile[] = [];
  let malformed = 0;
  for (const file of files) {
    try {
      if (!(await stat(file)).isFile()) continue;
      const fileEvents: UsageEvent[] = [];
      const context: TokenUsageContext = {};
      const ledger = new CodexLedgerCollector();
      const records: Record<string, unknown>[] = [];
      const eventsByLine: Array<{ event: UsageEvent; line: number }> = [];
      for (const line of (await readJsonlText(file)).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          records.push(record);
          ledger.observe(record);
          const result = normalizeTokenUsageRecord(record, context);
          if (result.context) mergeTokenUsageContext(context, result.context);
          if (result.event) eventsByLine.push({ event: result.event, line: records.length });
          if (result.malformed) malformed += 1;
        } catch {
          malformed += 1;
        }
      }
      const ownedSuffix = subagentOwnedSuffix(records, eventsByLine);
      const ownedEvents = ownedSuffix
        ? eventsByLine.filter((item) => item.line >= ownedSuffix.startLine)
        : eventsByLine;
      fileEvents.push(...ownedEvents.map((item) => item.event));
      const baselineEvent = ownedSuffix
        ? [...eventsByLine].reverse().find((item) => {
            if (item.line >= ownedSuffix.startLine) return false;
            return item.event.cumulative_usage || item.event.record_kind === "cumulative";
          })?.event
        : undefined;
      const rawOwnedSuffixBaseline = baselineEvent
        ? baselineEvent.cumulative_usage ?? totalsFromEvent(baselineEvent)
        : undefined;
      const firstOwnedEvent = ownedEvents.find(
        (item) => item.event.cumulative_usage || item.event.record_kind === "cumulative"
      )?.event;
      const firstOwnedTotal = firstOwnedEvent?.cumulative_usage;
      const inferredOwnedSuffixBaseline =
        !rawOwnedSuffixBaseline &&
        ownedSuffix?.explicitHistoryBoundary &&
        firstOwnedEvent?.cumulative_usage &&
        totalsAtLeast(firstOwnedEvent.cumulative_usage, totalsFromEvent(firstOwnedEvent))
          ? subtractTotals(firstOwnedEvent.cumulative_usage, totalsFromEvent(firstOwnedEvent))
          : undefined;
      const initialOwnedSuffixBaseline = rawOwnedSuffixBaseline ?? inferredOwnedSuffixBaseline;
      const ownedSuffixBaseline =
        initialOwnedSuffixBaseline &&
        firstOwnedEvent &&
        firstOwnedTotal &&
        totalsEqual(firstOwnedTotal, totalsFromEvent(firstOwnedEvent)) &&
        !totalsAtLeast(firstOwnedTotal, initialOwnedSuffixBaseline)
          ? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
          : initialOwnedSuffixBaseline;
      const sessionId =
        context.sessionId && context.sessionId !== "unknown"
          ? context.sessionId
          : fileEvents.find((event) => event.session_id !== "unknown")?.session_id;
      parsedFiles.push({
        events: fileEvents,
        ledger,
        snapshots: snapshotsFromEvents(fileEvents),
        ...(sessionId ? { sessionId } : {}),
        ...(context.parentId ? { parentId: context.parentId } : {}),
        ...(context.forkTimestamp ? { forkTimestamp: context.forkTimestamp } : {}),
        ...(ownedSuffixBaseline ? { ownedSuffixBaseline } : {})
      });
    } catch {
      malformed += 1;
    }
  }

  const snapshotsBySession = new Map<string, UsageSnapshot[]>();
  for (const parsed of parsedFiles) {
    if (parsed.sessionId && !snapshotsBySession.has(parsed.sessionId)) {
      snapshotsBySession.set(parsed.sessionId, parsed.snapshots);
    }
  }

  const events: UsageEvent[] = [];
  let duplicateRecords = 0;
  let ambiguousForkCount = 0;
  for (const parsed of parsedFiles) {
    const inherited = inheritedTotalsAt(
      parsed.parentId ? snapshotsBySession.get(parsed.parentId) : undefined,
      parsed.forkTimestamp
    );
    const adjustedEvents = applyInheritedTotals(parsed.events, parsed.ownedSuffixBaseline ?? inherited);
    const ledger = applyForkLedger(adjustedEvents);
    ambiguousForkCount += ledger.ambiguousForkCount;
    const nonZeroEvents = mergeLedgerRows(
      ledger.events.filter(hasUsage),
      parsed.ledger,
      parsed.sessionId ?? "unknown"
    ).filter(hasUsage);
    events.push(...nonZeroEvents);
  }

  // Deduplicate per request rather than per session: Codex pages a long thread
  // across several files that share its id, and each page holds distinct
  // requests. Exact copies (an active rollout and its archived twin) still
  // collapse, since a ledger row is keyed by response and a legacy row by its
  // turn, time, model, and size.
  const records: SessionUsageRecord[] = [];
  const seenKeys = new Set<string>();
  for (const record of events.map((event) => recordFromEvent(event, kind))) {
    if (seenKeys.has(record.dedupe_key)) {
      duplicateRecords += 1;
      continue;
    }
    seenKeys.add(record.dedupe_key);
    records.push(record);
  }
  const warnings = [
    ...(malformed > 0 ? [warning(malformedCode, malformed)] : []),
    ...(duplicateRecords > 0 ? [warning("duplicate_records_skipped", duplicateRecords)] : []),
    ...forkWarnings(ambiguousForkCount)
  ];
  return {
    records,
    warnings,
    status: {
      kind,
      enabled: true,
      status: malformed > 0 && records.length === 0 ? "malformed" : "read",
      record_count: records.length,
      ...(malformed > 0 ? { warning_code: malformedCode } : {})
    }
  };
}
