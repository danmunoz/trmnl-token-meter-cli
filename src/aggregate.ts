import { createHash } from "node:crypto";
import {
  estimateUsageCost,
  normalizeEstimateModelName,
  pricingCatalogVersion
} from "./pricing/index.js";
import { applyForkLedger, forkWarnings } from "./forks.js";
import { localDateKey, nextLocalDate, recordFromEvent } from "./cost-sources/jsonl.js";
import {
  AGGREGATE_SCHEMA_VERSION,
  COLLECTOR_VERSION,
  COST_ENGINE_VERSION,
  type AggregateSnapshot,
  type CodexBarCollectorInfo,
  type CollectorWarning,
  type CostProvenance,
  type CostStatus,
  type DailyUsage,
  type LocalUsageSourceStatus,
  type ModelUsage,
  type ProviderStatus,
  type SessionUsageRecord,
  type SourceProvider,
  type SourceSummary,
  type UsageEvent,
  type UsagePeriod,
  type WarningCode
} from "./types.js";
import { mergeWarnings, warning, warningCodes } from "./warnings.js";
import { SUPPORTED_PROVIDERS } from "./source-providers.js";

export interface AggregateOptions {
  machineId: string;
  machineLabel: string;
  codexHomeKind: "default" | "custom";
  now?: Date;
  warnings?: CollectorWarning[];
  sources?: LocalUsageSourceStatus[];
  showCost?: boolean;
  supportedProviders?: SourceProvider[];
  enabledProviders?: SourceProvider[];
  providerStatuses?: ProviderStatus[];
  codexBar?: CodexBarCollectorInfo;
}

const noCodexBar: CodexBarCollectorInfo = { available: false, version: null, providers: [] };

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
  total_tokens: 0,
  estimated_cost_usd: costStatus === "known" ? 0 : null,
  cost_status: costStatus,
  cost_provenance: "none",
  cost_catalog_versions: [],
  pricing_catalog_version: pricingCatalogVersion,
  warning_codes: []
});

const positiveInt = (value: number | undefined): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value ?? 0)) : 0;

const totalTokensForRecord = (record: SessionUsageRecord): number => {
  if (
    record.cache_creation_input_tokens !== undefined ||
    record.cache_read_input_tokens !== undefined
  ) {
    return (
      positiveInt(record.input_tokens) +
      positiveInt(record.cache_creation_input_tokens) +
      positiveInt(record.cache_read_input_tokens) +
      positiveInt(record.output_tokens)
    );
  }
  return positiveInt(record.input_tokens) + positiveInt(record.output_tokens);
};

const totalTokensForRecords = (records: readonly SessionUsageRecord[]): number =>
  records.reduce((total, record) => total + totalTokensForRecord(record), 0);

const sanitizeModelName = (name: string): string => {
  const normalized = normalizeEstimateModelName(name);
  if (normalized !== "unknown") return normalized;
  const fallback = name.trim().toLowerCase().replace(/\s+/g, "-") || "unknown";
  if (fallback.length <= 80 && /^[a-z0-9._:-]+$/.test(fallback)) return fallback;
  return `unknown-${createHash("sha256").update(fallback).digest("hex").slice(0, 12)}`;
};

const recordWarningCodes = (records: readonly SessionUsageRecord[]): WarningCode[] => {
  const codes = new Set<WarningCode>();
  if (
    records.some(
      (record) =>
        record.observed_cost_usd === undefined &&
        (record.source_provider === "opencode" ||
          !record.pricing_known ||
          sanitizeModelName(record.model) === "unknown")
    )
  ) {
    codes.add("unknown_pricing");
  }
  // All three codes describe uncertainty in this collector's own pricing. A record
  // whose cost was reported by CodexBar or by the provider is already priced, and
  // the long-context and priority-tier questions no longer affect its dollars.
  const catalogPriced = records.filter((record) => record.observed_cost_usd === undefined);
  if (catalogPriced.some((record) => record.long_context === "unknown")) {
    codes.add("long_context_pricing_unknown");
  }
  if (catalogPriced.some((record) => record.priority_tier === "unknown")) {
    codes.add("priority_evidence_missing");
  }
  return [...codes].sort();
};

type CostAttribution = Pick<
  UsagePeriod,
  "estimated_cost_usd" | "cost_status" | "cost_provenance" | "cost_catalog_versions" | "pricing_catalog_version"
>;

/** Collects which pricing engines produced dollars, and under which version. */
class CostSources {
  private readonly versions = new Map<CostProvenance, Set<string>>();

  add(provenance: CostProvenance, version: string): void {
    const seen = this.versions.get(provenance) ?? new Set<string>();
    seen.add(version);
    this.versions.set(provenance, seen);
  }

  addObserved(records: readonly SessionUsageRecord[]): void {
    for (const record of records) {
      if (record.observed_cost_usd === undefined) continue;
      const provenance: CostProvenance = record.cost_source ?? "provider_reported";
      this.add(provenance, record.cost_catalog_version ?? provenance);
    }
  }

  get provenance(): CostProvenance {
    const engines = [...this.versions.keys()];
    if (engines.length === 0) return "none";
    if (engines.length === 1) return engines[0] ?? "none";
    return "mixed";
  }

  get catalogVersions(): string[] {
    return [...new Set([...this.versions.values()].flatMap((set) => [...set]))].sort();
  }
}

const roundCost = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const estimateRecords = (
  records: readonly SessionUsageRecord[],
  showCost: boolean
): CostAttribution => {
  if (!showCost) {
    return {
      estimated_cost_usd: null,
      cost_status: "disabled",
      cost_provenance: "none",
      cost_catalog_versions: [],
      pricing_catalog_version: pricingCatalogVersion
    };
  }

  const sources = new CostSources();
  const observedCost = records.reduce(
    (total, record) => total + (record.observed_cost_usd ?? 0),
    0
  );
  const observedCostCount = records.filter((record) => record.observed_cost_usd !== undefined).length;
  sources.addObserved(records);
  const recordsWithoutObservedCost = records.filter((record) => record.observed_cost_usd === undefined);
  const unpricedOpenCodeRecords = recordsWithoutObservedCost.filter(
    (record) => record.source_provider === "opencode"
  );
  const catalogPricedRecords = recordsWithoutObservedCost.filter(
    (record) => record.source_provider !== "opencode"
  );
  if (catalogPricedRecords.length === 0) {
    const hasUnpricedOpenCode = unpricedOpenCodeRecords.length > 0;
    return {
      estimated_cost_usd:
        hasUnpricedOpenCode && observedCostCount === 0 ? null : roundCost(observedCost),
      cost_status: hasUnpricedOpenCode ? (observedCostCount > 0 ? "partial" : "unknown") : "known",
      cost_provenance: sources.provenance,
      cost_catalog_versions: sources.catalogVersions,
      pricing_catalog_version: pricingCatalogVersion
    };
  }

  const estimate = estimateUsageCost(
    catalogPricedRecords.map((record) => ({
      model: record.model,
      input_tokens: record.input_tokens,
      cached_input_tokens: record.cached_input_tokens,
      output_tokens: record.output_tokens,
      ...(record.cache_read_input_tokens !== undefined
        ? { cache_read_input_tokens: record.cache_read_input_tokens }
        : {}),
      ...(record.cache_creation_input_tokens !== undefined
        ? { cache_creation_input_tokens: record.cache_creation_input_tokens }
        : {}),
      long_context: record.long_context,
      priority_tier: record.priority_tier
    })),
    { showCost: true }
  );

  if (estimate.estimated_cost_usd !== null) {
    sources.add("local_catalog", estimate.pricing_catalog_version);
  }

  const hasObservedCost = observedCostCount > 0;
  const hasUnpricedOpenCode = unpricedOpenCodeRecords.length > 0;
  const estimatedCost =
    estimate.estimated_cost_usd === null
      ? hasObservedCost
        ? roundCost(observedCost)
        : null
      : roundCost(observedCost + estimate.estimated_cost_usd);

  return {
    estimated_cost_usd: estimatedCost,
    cost_status:
      hasUnpricedOpenCode || (hasObservedCost && estimate.cost_status === "unknown")
        ? "partial"
        : estimate.cost_status,
    cost_provenance: sources.provenance,
    cost_catalog_versions: sources.catalogVersions,
    pricing_catalog_version: pricingCatalogVersion
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
  const warnings = recordWarningCodes(included);
  const estimate = estimateRecords(included, showCost);
  return {
    ...period,
    ...estimate,
    total_tokens: totalTokensForRecords(included),
    warning_codes: warnings
  };
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
  const models = new Map<string, SessionUsageRecord[]>();
  for (const record of recordsInWindow(records, start, endExclusive)) {
    const name = sanitizeModelName(record.model);
    const item = models.get(name) ?? [];
    item.push(record);
    models.set(name, item);
  }

  return [...models.entries()]
    .map(([name, modelRecords]) => {
      const estimate = estimateRecords(modelRecords, showCost);
      return {
        name,
        total_tokens: totalTokensForRecords(modelRecords),
        ...estimate,
        warning_codes: recordWarningCodes(modelRecords)
      };
    })
    .sort((a, b) => b.total_tokens - a.total_tokens)
    .slice(0, 25);
};

const buildUsageSections = (
  records: readonly SessionUsageRecord[],
  today: string,
  tomorrow: string,
  start7: string,
  start14: string,
  start30: string,
  startDaily: string,
  showCost: boolean
): Pick<AggregateSnapshot, "periods" | "daily" | "models"> => ({
  periods: {
    today: aggregatePeriod(records, today, tomorrow, showCost),
    last_7_days: aggregatePeriod(records, start7, tomorrow, showCost),
    last_14_days: aggregatePeriod(records, start14, tomorrow, showCost),
    last_30_days: aggregatePeriod(records, start30, tomorrow, showCost)
  },
  daily: buildDaily(records, startDaily, tomorrow, showCost),
  models: buildModels(records, start30, tomorrow, showCost)
});

const buildSourceSummaries = (
  records: readonly SessionUsageRecord[],
  today: string,
  tomorrow: string,
  start7: string,
  start14: string,
  start30: string,
  startDaily: string,
  showCost: boolean
): SourceSummary[] => {
  const providers: SourceProvider[] = ["codex", "opencode", "claude"];
  return providers.flatMap((provider) => {
    const providerRecords = records.filter((record) => (record.source_provider ?? "codex") === provider);
    if (providerRecords.length === 0) return [];
    return [
      {
        provider,
        ...buildUsageSections(providerRecords, today, tomorrow, start7, start14, start30, startDaily, showCost)
      }
    ];
  });
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
  const start14 = addDays(today, -13);
  const startDaily = addDays(today, -14);
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
  const sections = buildUsageSections(
    deduped.records,
    today,
    tomorrow,
    start7,
    start14,
    start30,
    startDaily,
    showCost
  );
  const sourceSummaries = buildSourceSummaries(
    deduped.records,
    today,
    tomorrow,
    start7,
    start14,
    start30,
    startDaily,
    showCost
  );

  return {
    schema_version: AGGREGATE_SCHEMA_VERSION,
    machine_id: options.machineId,
    machine_label: options.machineLabel.slice(0, 80),
    generated_at: now.toISOString(),
    ...sections,
    ...(sourceSummaries.length > 0 ? { source_summaries: sourceSummaries } : {}),
    collector: {
      version: COLLECTOR_VERSION,
      source: "codexbar-local-cost",
      codex_home: options.codexHomeKind,
      cost_engine_version: COST_ENGINE_VERSION,
      supported_providers: options.supportedProviders ?? SUPPORTED_PROVIDERS,
      enabled_providers: options.enabledProviders ?? ["codex"],
      provider_statuses: options.providerStatuses ?? [],
      codexbar: options.codexBar ?? noCodexBar,
      sources: options.sources ?? [],
      warnings
    }
  };
}
