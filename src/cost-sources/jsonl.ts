import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
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
  SessionUsageRecord,
  UsageEvent,
  WarningCode
} from "../types.js";
import { warning } from "../warnings.js";

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

async function discoverJsonlFiles(dir: string, output: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await discoverJsonlFiles(path, output);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      output.push(path);
    }
  }
  return output;
}

const eventDedupeKey = (event: UsageEvent): string =>
  [
    event.session_id,
    event.timestamp.toISOString(),
    event.model,
    event.input_tokens,
    event.cached_input_tokens,
    event.output_tokens
  ].join(":");

export const recordFromEvent = (
  event: UsageEvent,
  sourceKind: LocalUsageSourceKind
): SessionUsageRecord => ({
  dedupe_key: eventDedupeKey(event),
  source_kind: sourceKind,
  occurred_at: event.timestamp,
  local_date: localDateKey(event.timestamp),
  model: event.model,
  model_alias: event.model,
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
  sessionId?: string;
  parentId?: string;
  forkTimestamp?: string;
  snapshots: UsageSnapshot[];
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

function snapshotsFromEvents(events: readonly UsageEvent[]): UsageSnapshot[] {
  const snapshots: UsageSnapshot[] = [];
  let current: UsageTotals = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };
  for (const event of [...events].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
    current =
      event.record_kind === "cumulative"
        ? totalsFromEvent(event)
        : addTotals(current, totalsFromEvent(event));
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
  if (!inherited) return [...events];
  let remaining: UsageTotals | undefined = inherited;
  return events.map((event) => {
    if (event.record_kind === "cumulative") {
      remaining = undefined;
      return { ...event, ...subtractTotals(totalsFromEvent(event), inherited) };
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
      for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const result = normalizeTokenUsageRecord(JSON.parse(line), context);
          if (result.context) mergeTokenUsageContext(context, result.context);
          if (result.event) fileEvents.push(result.event);
          if (result.malformed) malformed += 1;
        } catch {
          malformed += 1;
        }
      }
      const sessionId =
        context.sessionId && context.sessionId !== "unknown"
          ? context.sessionId
          : fileEvents.find((event) => event.session_id !== "unknown")?.session_id;
      parsedFiles.push({
        events: fileEvents,
        snapshots: snapshotsFromEvents(fileEvents),
        ...(sessionId ? { sessionId } : {}),
        ...(context.parentId ? { parentId: context.parentId } : {}),
        ...(context.forkTimestamp ? { forkTimestamp: context.forkTimestamp } : {})
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
  const seenSessionIds = new Set<string>();
  let duplicateRecords = 0;
  let ambiguousForkCount = 0;
  for (const parsed of parsedFiles) {
    const inherited = inheritedTotalsAt(
      parsed.parentId ? snapshotsBySession.get(parsed.parentId) : undefined,
      parsed.forkTimestamp
    );
    const adjustedEvents = applyInheritedTotals(parsed.events, inherited);
    const ledger = applyForkLedger(adjustedEvents);
    ambiguousForkCount += ledger.ambiguousForkCount;
    const nonZeroEvents = ledger.events.filter(hasUsage);
    if (parsed.sessionId && seenSessionIds.has(parsed.sessionId)) {
      duplicateRecords += nonZeroEvents.length;
      continue;
    }
    if (parsed.sessionId) seenSessionIds.add(parsed.sessionId);
    events.push(...nonZeroEvents);
  }

  const records = events.map((event) => recordFromEvent(event, kind));
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
