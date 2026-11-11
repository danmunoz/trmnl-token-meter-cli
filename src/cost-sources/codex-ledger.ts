import type { TokenUsage, UsageEvent } from "../types.js";

// Codex per-request ledger, ported from CodexBar 0.84.0's `token_usage_record`
// handling (CostUsageScanner.swift) and its rollout-native Fast tier
// (`thread_settings_applied`). Attribution: CodexBar, MIT license.
//
// Newer Codex writes one `token_usage_record` per model response next to the
// legacy cumulative `token_count`. The record names its own thread and response,
// so it counts each request exactly once even where the cumulative counters
// replay or restart (resumes, compaction). CodexBar counts owned records and drops
// the `token_count` that mirrors each one; a `token_count` with no record behind
// it is still counted the legacy way.

type RequestTotals = { input: number; cached: number; output: number };

export interface LedgerRow {
  timestamp: Date;
  responseId: string;
  turnId?: string;
  model: string;
  usage: RequestTotals;
  threadTotal: RequestTotals;
}

/** Same-response events are written within a few seconds of each other. */
const mirrorWindowMs = 5000;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const objectOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const turnIdOf = (payload: Record<string, unknown>): string | undefined =>
  text(payload.turn_id) ?? text(payload.turnId) ?? text(payload.id);

/** Strict like CodexBar: non-negative integers, cached within input, reasoning within output. */
function requestTotals(raw: unknown): RequestTotals | undefined {
  const usage = objectOf(raw);
  if (!usage) return undefined;
  const integer = (key: string, fallback?: number): number | undefined => {
    const value = usage[key];
    if (value === undefined) return fallback;
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const input = integer("input_tokens");
  const output = integer("output_tokens");
  const cached = integer("cached_input_tokens", 0);
  const reasoning = integer("reasoning_output_tokens", 0);
  if (input === undefined || output === undefined || cached === undefined || reasoning === undefined) {
    return undefined;
  }
  if (cached > input || reasoning > output) return undefined;
  return { input, cached, output };
}

const atLeast = (total: RequestTotals, usage: RequestTotals): boolean =>
  total.input >= usage.input && total.cached >= usage.cached && total.output >= usage.output;

type Tier = "priority" | "standard" | "unknown";

const tierOf = (settings: Record<string, unknown> | undefined): Tier | undefined => {
  if (!settings) return undefined;
  const tier = settings.service_tier;
  if (tier === undefined || tier === null || tier === "default") return "standard";
  return tier === "priority" ? "priority" : "unknown";
};

/**
 * Collects one rollout file's owned ledger rows and Fast-tier turns. Feed it every
 * parsed line in file order alongside the legacy parser.
 */
export class CodexLedgerCollector {
  private leafThreadId: string | undefined;
  private requestSessionId: string | undefined;
  private sawSessionMeta = false;
  private currentTurnId: string | undefined;
  private activeTurnId: string | undefined;
  private currentModel: string | undefined;
  private readonly turnModels = new Map<string, string>();
  private threadTier: Tier | undefined;
  private readonly priorityTurns = new Set<string>();
  private readonly responseIds = new Set<string>();
  readonly rows: LedgerRow[] = [];

  observe(record: Record<string, unknown>): void {
    const payload = objectOf(record.payload);
    switch (record.type) {
      case "session_meta":
        // The first meta is the leaf thread; later ones are embedded ancestors.
        if (!this.sawSessionMeta && payload) {
          this.sawSessionMeta = true;
          this.leafThreadId = text(payload.id) ?? text(record.id);
          this.requestSessionId = text(payload.session_id);
        }
        return;
      case "turn_context": {
        if (!payload) return;
        const turnId = turnIdOf(payload);
        if (turnId) {
          this.activeTurnId = turnId;
          // A resumed turn refreshes its tier without another task_started.
          if (this.threadTier && (this.currentTurnId === undefined || this.currentTurnId === turnId)) {
            this.markTurnTier(turnId);
          }
        }
        const info = objectOf(payload.info);
        const model = [payload.model, payload.model_name, info?.model, info?.model_name].find(
          (value) => typeof value === "string"
        );
        // An explicitly blank model clears stale evidence; an omitted one keeps it.
        if (typeof model === "string") this.currentModel = text(model)?.trim();
        if (turnId && this.currentModel) this.turnModels.set(turnId, this.currentModel);
        return;
      }
      case "event_msg":
        if (payload?.type === "thread_settings_applied") {
          this.threadTier = tierOf(objectOf(payload.thread_settings)) ?? this.threadTier;
        } else if (payload?.type === "task_started") {
          this.currentTurnId = turnIdOf(payload);
          if (this.currentTurnId) this.markTurnTier(this.currentTurnId);
        }
        return;
      case "token_usage_record":
        if (payload) this.observeRequest(record, payload);
        return;
      default:
        return;
    }
  }

  private markTurnTier(turnId: string): void {
    if (this.threadTier === "priority") this.priorityTurns.add(turnId);
    else this.priorityTurns.delete(turnId);
  }

  private observeRequest(record: Record<string, unknown>, payload: Record<string, unknown>): void {
    const threadId = text(payload.thread_id);
    const responseId = text(payload.response_id);
    const timestampText = text(record.timestamp);
    const usage = requestTotals(payload.usage);
    const threadTotal = requestTotals(payload.thread_token_usage);
    if (!threadId || !responseId || !timestampText || !usage || !threadTotal) return;
    if (!atLeast(threadTotal, usage)) return;
    const timestamp = new Date(timestampText);
    if (Number.isNaN(timestamp.getTime())) return;

    // Only the leaf thread's own records count; copied parent records do not.
    if (!this.leafThreadId || threadId !== this.leafThreadId) return;
    const sessionId = payload.session_id;
    if (sessionId !== undefined) {
      if (!text(sessionId)) return;
      if (sessionId !== (this.requestSessionId ?? this.leafThreadId)) return;
    }
    // Identity, not cumulative counters, proves a new request.
    if (this.responseIds.has(responseId)) return;
    this.responseIds.add(responseId);

    const turnId = turnIdOf(payload) ?? this.currentTurnId ?? this.activeTurnId;
    const model =
      text(payload.model) ??
      (turnId ? this.turnModels.get(turnId) : undefined) ??
      (turnId === this.currentTurnId || turnId === this.activeTurnId ? this.currentModel : undefined) ??
      "unknown";
    this.rows.push({ timestamp, responseId, ...(turnId ? { turnId } : {}), model, usage, threadTotal });
  }

  isPriorityTurn(turnId: string | undefined): boolean {
    return turnId !== undefined && this.priorityTurns.has(turnId);
  }
}

const sameUsage = (a: TokenUsage, b: RequestTotals): boolean =>
  a.input_tokens === b.input && a.cached_input_tokens === b.cached && a.output_tokens === b.output;

const subtract = (a: RequestTotals, b: RequestTotals): TokenUsage => ({
  input_tokens: a.input - b.input,
  cached_input_tokens: a.cached - b.cached,
  output_tokens: a.output - b.output
});

const totalsOf = (usage: TokenUsage): RequestTotals => ({
  input: usage.input_tokens,
  cached: usage.cached_input_tokens,
  output: usage.output_tokens
});

/** `token_count` events whose thread counter advanced by exactly their own request. */
function exactLegacyAdvances(events: readonly UsageEvent[]): Set<UsageEvent> {
  const exact = new Set<UsageEvent>();
  let previous: RequestTotals | undefined;
  const ordered = events
    .filter((event) => event.request_thread_total && event.request_usage)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  for (const event of ordered) {
    const total = totalsOf(event.request_thread_total!);
    if (previous && sameUsage(subtract(total, previous), totalsOf(event.request_usage!))) exact.add(event);
    previous = total;
  }
  return exact;
}

/**
 * Replaces each legacy `token_count` event that mirrors a ledger row with that
 * row, keeps unmirrored legacy events, and marks Fast-tier turns as priority.
 *
 * A mirror reports the same request size (its raw `last_token_usage`) in the same
 * turn, and one of, in order:
 * - the same thread counter (`total_token_usage` equal to the record's
 *   `thread_token_usage`), at any distance;
 * - a timestamp within a few seconds;
 * - a later timestamp with no other request in between, where both counters
 *   advanced by exactly this request (the counters drift apart after compaction,
 *   and Codex can write the `token_count` well after the record).
 * CodexBar pairs mirrors by the same evidence.
 */
export function mergeLedgerRows(
  legacyEvents: readonly UsageEvent[],
  collector: CodexLedgerCollector,
  sessionId: string
): UsageEvent[] {
  const claimed = new Set<UsageEvent>();
  const legacyExact = exactLegacyAdvances(legacyEvents);
  const rows = collector.rows;
  const ledgerEvents: UsageEvent[] = rows.map((row, index) => {
    const previous = index > 0 ? rows[index - 1] : undefined;
    const next = rows[index + 1];
    const rowExact =
      previous !== undefined && sameUsage(subtract(row.threadTotal, previous.threadTotal), row.usage);
    const candidates = legacyEvents.filter(
      (event) =>
        !claimed.has(event) &&
        event.request_usage !== undefined &&
        sameUsage(event.request_usage, row.usage) &&
        (row.turnId === undefined || event.turn_id === undefined || event.turn_id === row.turnId)
    );
    const mirror =
      candidates.find(
        (event) => event.request_thread_total && sameUsage(event.request_thread_total, row.threadTotal)
      ) ??
      candidates.find(
        (event) => Math.abs(event.timestamp.getTime() - row.timestamp.getTime()) <= mirrorWindowMs
      ) ??
      (rowExact
        ? candidates.find(
            (event) =>
              legacyExact.has(event) &&
              event.timestamp.getTime() >= row.timestamp.getTime() &&
              (next === undefined || event.timestamp.getTime() < next.timestamp.getTime())
          )
        : undefined);
    if (mirror) claimed.add(mirror);
    return {
      input_tokens: row.usage.input,
      cached_input_tokens: row.usage.cached,
      output_tokens: row.usage.output,
      timestamp: row.timestamp,
      model: row.model,
      session_id: sessionId,
      ...(row.turnId ? { turn_id: row.turnId } : {}),
      response_id: row.responseId,
      long_context: mirror?.long_context ?? false,
      priority_tier: mirror?.priority_tier === "priority" ? "priority" : "base",
      record_kind: "delta"
    };
  });

  return [...legacyEvents.filter((event) => !claimed.has(event)), ...ledgerEvents].map((event) =>
    collector.isPriorityTurn(event.turn_id) && event.priority_tier !== "priority"
      ? { ...event, priority_tier: "priority" }
      : event
  );
}
