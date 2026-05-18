import { createHash } from "node:crypto";
import {
  estimateUsageCost,
  normalizeEstimateModelName,
  priorityTokens,
  pricingCatalogVersion
} from "./pricing/index.js";
import { applyForkLedger, forkWarnings } from "./forks.js";
import { localDateKey, nextLocalDate, recordFromEvent } from "./cost-sources/jsonl.js";
import {
  AGGREGATE_SCHEMA_VERSION,
  COLLECTOR_VERSION,
  COST_ENGINE_VERSION,
  type AggregateSnapshot,
  type CollectorWarning,
  type CostStatus,
  type DailyUsage,
  type LocalUsageSourceStatus,
  type ModelUsage,
  type SessionUsageRecord,
  type TokenUsage,
  type UsageEvent,
  type UsagePeriod,
  type WarningCode
} from "./types.js";
import { mergeWarnings, warning, warningCodes } from "./warnings.js";

export interface AggregateOptions {
  machineId: string;
  machineLabel: string;
  codexHomeKind: "default" | "custom";
  now?: Date;
  warnings?: CollectorWarning[];
  sources?: LocalUsageSourceStatus[];
  showCost?: boolean;
}

const addDays = (date: string, days: number): string => nextLocalDate(date, days);

const toLocalRecords = (
  rows: Array<UsageEvent | SessionUsageRecord>
): { records: SessionUsageRecord[]; forkWarnings: CollectorWarning[] } => {
  if (rows.length === 0) return { records: [], forkWarnings: [] };
  const first = rows[0];
  if (first && "dedupe_key" in first) {
    return { records: rows as SessionUsageRecord[], forkWarnings: [] };
  }

  const ledger = applyForkLedger(rows as UsageEvent[]);
  return {
    records: ledger.events.map((event) => recordFromEvent(event, "codex_sessions")),
    forkWarnings: forkWarnings(ledger.ambiguousForkCount)
  };
};

const emptyPeriod = (start: string, end: string, costStatus: CostStatus): UsagePeriod => ({
  start,
  end,
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  total_tokens: 0,
  estimated_cost_usd: costStatus === "known" ? 0 : null,
  cost_status: costStatus,
  pricing_catalog_version: pricingCatalogVersion,
  warning_codes: []
});

const addUsage = (target: TokenUsage, record: TokenUsage): void => {
  target.input_tokens += Math.max(0, Math.floor(record.input_tokens));
  target.cached_input_tokens += Math.max(
    0,
    Math.min(Math.floor(record.cached_input_tokens), Math.floor(record.input_tokens))
  );
  target.output_tokens += Math.max(0, Math.floor(record.output_tokens));
};

const withTotals = <T extends TokenUsage & { total_tokens: number }>(value: T): T => ({
  ...value,
  cached_input_tokens: Math.min(value.cached_input_tokens, value.input_tokens),
  total_tokens: value.input_tokens + value.output_tokens
});

const sanitizeModelName = (name: string): string => {
  const normalized = normalizeEstimateModelName(name);
  if (normalized !== "unknown") return normalized;
  const fallback = name.trim().toLowerCase().replace(/\s+/g, "-") || "unknown";
  if (fallback.length <= 80 && /^[a-z0-9._:-]+$/.test(fallback)) return fallback;
  return `unknown-${createHash("sha256").update(fallback).digest("hex").slice(0, 12)}`;
};

const recordWarningCodes = (records: readonly SessionUsageRecord[]): WarningCode[] => {
  const codes = new Set<WarningCode>();
  if (records.some((record) => !record.pricing_known || sanitizeModelName(record.model) === "unknown")) {
    codes.add("unknown_pricing");
  }
  if (records.some((record) => record.long_context === "unknown")) {
    codes.add("long_context_pricing_unknown");
  }
  if (records.some((record) => record.priority_tier === "unknown")) {
    codes.add("priority_evidence_missing");
  }
  return [...codes].sort();
};

const estimateRecords = (
  records: readonly SessionUsageRecord[],
  showCost: boolean
): Pick<UsagePeriod, "estimated_cost_usd" | "cost_status" | "pricing_catalog_version"> => {
  const estimate = estimateUsageCost(
    records.map((record) => ({
      model: record.model,
      input_tokens: record.input_tokens,
      cached_input_tokens: record.cached_input_tokens,
      output_tokens: record.output_tokens,
      long_context: record.long_context,
      priority_tier: record.priority_tier
    })),
    { showCost }
  );

  return {
    estimated_cost_usd: estimate.estimated_cost_usd,
    cost_status: estimate.cost_status,
    pricing_catalog_version: estimate.pricing_catalog_version
  };
};

const recordsInWindow = (
  records: readonly SessionUsageRecord[],
  start: string,
  endExclusive: string
): SessionUsageRecord[] =>
  records.filter((record) => record.local_date >= start && record.local_date < endExclusive);

const aggregatePeriod = (
  records: readonly SessionUsageRecord[],
  start: string,
  endExclusive: string,
  showCost: boolean
): UsagePeriod => {
  const included = recordsInWindow(records, start, endExclusive);
  const period = emptyPeriod(start, endExclusive, showCost ? "known" : "disabled");
  for (const record of included) addUsage(period, record);
  const warnings = recordWarningCodes(included);
  const estimate = estimateRecords(included, showCost);
  return withTotals({ ...period, ...estimate, warning_codes: warnings });
};

const buildDaily = (
  records: readonly SessionUsageRecord[],
  start: string,
  endExclusive: string,
  showCost: boolean
): DailyUsage[] => {
  const days: DailyUsage[] = [];
  for (let day = start; day < endExclusive; day = addDays(day, 1)) {
    const next = addDays(day, 1);
    const period = aggregatePeriod(records, day, next, showCost);
    days.push({
      ...period,
      date: day,
      has_usage: period.total_tokens > 0,
      is_missing: false
    });
  }
  return days;
};

const buildModels = (
  records: readonly SessionUsageRecord[],
  start: string,
  endExclusive: string,
  showCost: boolean
): ModelUsage[] => {
  const models = new Map<string, { usage: ModelUsage; records: SessionUsageRecord[] }>();
  for (const record of recordsInWindow(records, start, endExclusive)) {
    const name = sanitizeModelName(record.model);
    const item =
      models.get(name) ??
      ({
        usage: {
          name,
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          estimated_cost_usd: null,
          cost_status: showCost ? "known" : "disabled",
          pricing_catalog_version: pricingCatalogVersion,
          warning_codes: []
        },
        records: []
      } satisfies { usage: ModelUsage; records: SessionUsageRecord[] });
    addUsage(item.usage, record);
    item.usage.long_context_tokens =
      (item.usage.long_context_tokens ?? 0) +
      (record.long_context === true ? record.input_tokens + record.output_tokens : 0);
    item.usage.priority_tokens =
      (item.usage.priority_tokens ?? 0) +
      priorityTokens(record.priority_tier, record.input_tokens, record.output_tokens);
    item.records.push(record);
    models.set(name, item);
  }

  return [...models.values()]
    .map(({ usage, records: modelRecords }) => {
      const estimate = estimateRecords(modelRecords, showCost);
      return withTotals({ ...usage, ...estimate, warning_codes: recordWarningCodes(modelRecords) });
    })
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, 25);
};

const dedupeRecords = (
  records: readonly SessionUsageRecord[]
): { records: SessionUsageRecord[]; duplicateCount: number } => {
  const seen = new Set<string>();
  const output: SessionUsageRecord[] = [];
  let duplicateCount = 0;
  for (const record of records) {
    if (seen.has(record.dedupe_key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(record.dedupe_key);
    output.push(record);
  }
  return { records: output, duplicateCount };
};

export function buildAggregate(
  rows: Array<UsageEvent | SessionUsageRecord>,
  options: AggregateOptions
): AggregateSnapshot {
  const now = options.now ?? new Date();
  const today = localDateKey(now);
  const tomorrow = addDays(today, 1);
  const start30 = addDays(today, -29);
  const startDaily = addDays(today, -30);
  const start7 = addDays(today, -6);
  const showCost = options.showCost ?? true;
  const normalized = toLocalRecords(rows);
  const deduped = dedupeRecords(normalized.records);
  const baseWarnings = [
    ...(options.warnings ?? []),
    ...normalized.forkWarnings,
    ...(deduped.duplicateCount > 0 ? [warning("duplicate_records_skipped", deduped.duplicateCount)] : [])
  ];
  const aggregateWarnings = [
    ...baseWarnings,
    ...warningCodes(
      recordWarningCodes(deduped.records).map((code) => warning(code))
    ).map((code) => warning(code))
  ];
  const warnings = mergeWarnings(aggregateWarnings);

  return {
    schema_version: AGGREGATE_SCHEMA_VERSION,
    machine_id: options.machineId,
    machine_label: options.machineLabel.slice(0, 80),
    generated_at: now.toISOString(),
    periods: {
      today: aggregatePeriod(deduped.records, today, tomorrow, showCost),
      last_7_days: aggregatePeriod(deduped.records, start7, tomorrow, showCost),
      last_30_days: aggregatePeriod(deduped.records, start30, tomorrow, showCost)
    },
    daily: buildDaily(deduped.records, startDaily, tomorrow, showCost),
    models: buildModels(deduped.records, start30, tomorrow, showCost),
    collector: {
      version: COLLECTOR_VERSION,
      source: "codexbar-local-cost",
      codex_home: options.codexHomeKind,
      cost_engine_version: COST_ENGINE_VERSION,
      sources: options.sources ?? [],
      warnings
    }
  };
}
