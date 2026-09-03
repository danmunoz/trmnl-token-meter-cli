import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };

export const AGGREGATE_SCHEMA_VERSION = "2026-09-03.v5-cost-provenance";
export const COLLECTOR_VERSION =
  typeof packageJson.version === "string" ? packageJson.version : "0.0.0-development";
export const COST_ENGINE_VERSION = "2026-09-01.codexbar-counter-parity";
export const DEFAULT_UPLOAD_INTERVAL_MINUTES = 60;

export type CostStatus = "known" | "partial" | "unknown" | "disabled";

/**
 * Where the dollars in a row actually came from.
 *
 * `cost_status` says how complete a cost figure is; this says who priced it, which
 * is a different question once more than one pricing engine can contribute. A row
 * priced by a locally installed CodexBar is not the bundled catalog's work, and the
 * backend cannot tell the two apart from the numbers alone.
 */
export type CostProvenance =
  | "local_catalog"
  | "codexbar_cli"
  | "provider_reported"
  | "mixed"
  | "none";

/** The pricing engine that produced a record's `observed_cost_usd`. */
export type RecordCostSource = "codexbar_cli" | "provider_reported";
export type WarningSeverity = "info" | "warning" | "error";
export type SourceProvider = "codex" | "opencode" | "claude";
export type WarningCode =
  | "codex_sessions_missing"
  | "codex_archived_sessions_missing"
  | "malformed_records_skipped"
  | "unknown_pricing"
  | "long_context_pricing_unknown"
  | "priority_evidence_missing"
  | "priority_evidence_unreadable"
  | "priority_evidence_malformed"
  | "opencode_sqlite_missing"
  | "opencode_sqlite_unreadable"
  | "opencode_sqlite_malformed"
  | "pi_sessions_disabled"
  | "pi_sessions_missing"
  | "pi_sessions_malformed"
  | "codexbar_unavailable"
  | "codexbar_failed"
  | "codexbar_pricing_incomplete"
  | "duplicate_records_skipped"
  | "stale_upload"
  | "upload_rejected";

export interface CollectorWarning {
  code: WarningCode;
  severity: WarningSeverity;
  count?: number;
}

export interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface UsageEvent extends TokenUsage {
  timestamp: Date;
  model: string;
  session_id: string;
  cumulative_usage?: TokenUsage;
  turn_id?: string;
  branch_id?: string;
  parent_id?: string;
  long_context?: boolean | "unknown";
  priority_tier?: "base" | "priority" | "unknown";
  record_kind: "delta" | "cumulative";
}

export interface UsagePeriod {
  start: string;
  end: string;
  total_tokens: number;
  estimated_cost_usd: number | null;
  cost_status: CostStatus;
  cost_provenance: CostProvenance;
  /**
   * Identifiers for the pricing engines that produced `estimated_cost_usd`, such as
   * `2026-07-12.codexbar-parity` or `codexbar-cli-0.56.3`. Empty when there is no
   * cost. `pricing_catalog_version` keeps its existing meaning — the bundled
   * catalog this collector shipped with — whether or not it priced this row.
   */
  cost_catalog_versions: string[];
  pricing_catalog_version: string;
  warning_codes: WarningCode[];
}

export interface DailyUsage extends UsagePeriod {
  date: string;
  has_usage: boolean;
  is_missing: boolean;
}

export interface ModelUsage {
  name: string;
  total_tokens: number;
  estimated_cost_usd: number | null;
  cost_status: CostStatus;
  cost_provenance: CostProvenance;
  cost_catalog_versions: string[];
  pricing_catalog_version: string;
  warning_codes: WarningCode[];
}

export type LocalUsageSourceKind =
  | "codex_sessions"
  | "codex_archived_sessions"
  | "codex_priority_sqlite"
  | "opencode_sqlite"
  | "claude_projects"
  | "pi_sessions"
  | "codexbar_cost";

export type LocalUsageSourceStatusValue =
  | "read"
  | "missing"
  | "unreadable"
  | "malformed"
  | "disabled";

export interface LocalUsageSourceStatus {
  kind: LocalUsageSourceKind;
  enabled: boolean;
  status: LocalUsageSourceStatusValue;
  record_count?: number;
  warning_code?: WarningCode;
}

export interface ProviderStatus {
  provider: SourceProvider;
  status: "available" | LocalUsageSourceStatusValue;
  warning_code?: WarningCode;
}

export interface PriorityTierEvidence {
  match_key: string;
  tier: "base" | "priority" | "unknown";
  confidence: "exact" | "inferred" | "unmatched";
  model?: string;
  warning_code?: WarningCode;
}

export interface SessionUsageRecord extends TokenUsage {
  dedupe_key: string;
  source_provider: SourceProvider;
  source_kind: LocalUsageSourceKind;
  occurred_at: Date;
  local_date: string;
  model: string;
  model_alias?: string;
  turn_id?: string;
  observed_cost_usd?: number;
  cost_source?: RecordCostSource;
  cost_catalog_version?: string;
  long_context: boolean | "unknown";
  priority_tier: "base" | "priority" | "unknown";
  pricing_known: boolean;
}

export interface CostWindow {
  name: "today" | "last_7_days" | "last_14_days" | "last_30_days";
  start: string;
  end: string;
}

export interface CostAggregationResult {
  records: SessionUsageRecord[];
  sources: LocalUsageSourceStatus[];
  providerStatuses: ProviderStatus[];
  warnings: CollectorWarning[];
  codexBar: CodexBarCollectorInfo;
}

export interface AggregateSnapshot {
  schema_version: typeof AGGREGATE_SCHEMA_VERSION;
  machine_id: string;
  machine_label: string;
  generated_at: string;
  periods: {
    today: UsagePeriod;
    last_7_days: UsagePeriod;
    last_14_days: UsagePeriod;
    last_30_days: UsagePeriod;
  };
  daily: DailyUsage[];
  models: ModelUsage[];
  source_summaries?: SourceSummary[];
  collector: {
    version: string;
    source: "codexbar-local-cost";
    codex_home: "default" | "custom";
    cost_engine_version: string;
    supported_providers: SourceProvider[];
    enabled_providers: SourceProvider[];
    codexbar: CodexBarCollectorInfo;
    sources: LocalUsageSourceStatus[];
    provider_statuses: ProviderStatus[];
    warnings: CollectorWarning[];
  };
}

/** Whether a local CodexBar install priced any of this snapshot, and which one. */
export interface CodexBarCollectorInfo {
  available: boolean;
  version: string | null;
  providers: SourceProvider[];
}

export interface SourceSummary {
  provider: SourceProvider;
  periods: AggregateSnapshot["periods"];
  daily: DailyUsage[];
  models: ModelUsage[];
}

export interface CollectorCredential {
  collector_token: string;
  api_base_url: string;
  machine_id: string;
  machine_label: string;
  upload_interval_minutes: number;
  enabled_providers?: SourceProvider[];
}

export interface SourceNoticeState {
  known_supported_providers: SourceProvider[];
}
