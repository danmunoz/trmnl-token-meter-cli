import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };

export const AGGREGATE_SCHEMA_VERSION = "2026-05-15.v2-codexbar-cost";
export const COLLECTOR_VERSION =
  typeof packageJson.version === "string" ? packageJson.version : "0.0.0-development";
export const COST_ENGINE_VERSION = "2026-05-15.codexbar-parity";
export const DEFAULT_UPLOAD_INTERVAL_MINUTES = 60;

export type CostStatus = "known" | "partial" | "unknown" | "disabled";
export type WarningSeverity = "info" | "warning" | "error";
export type WarningCode =
  | "codex_sessions_missing"
  | "codex_archived_sessions_missing"
  | "malformed_records_skipped"
  | "unknown_pricing"
  | "long_context_pricing_unknown"
  | "priority_evidence_missing"
  | "priority_evidence_unreadable"
  | "priority_evidence_malformed"
  | "pi_sessions_disabled"
  | "pi_sessions_missing"
  | "pi_sessions_malformed"
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
}

export interface UsageEvent extends TokenUsage {
  timestamp: Date;
  model: string;
  session_id: string;
  branch_id?: string;
  parent_id?: string;
  long_context?: boolean | "unknown";
  priority_tier?: "base" | "priority" | "unknown";
  record_kind: "delta" | "cumulative";
}

export interface UsagePeriod extends TokenUsage {
  start: string;
  end: string;
  total_tokens: number;
  estimated_cost_usd: number | null;
  cost_status: CostStatus;
  pricing_catalog_version: string;
  warning_codes: WarningCode[];
}

export interface DailyUsage extends UsagePeriod {
  date: string;
  has_usage: boolean;
  is_missing: boolean;
}

export interface ModelUsage extends TokenUsage {
  name: string;
  total_tokens: number;
  estimated_cost_usd: number | null;
  cost_status: CostStatus;
  pricing_catalog_version: string;
  warning_codes: WarningCode[];
  long_context_tokens?: number;
  priority_tokens?: number;
}

export type LocalUsageSourceKind =
  | "codex_sessions"
  | "codex_archived_sessions"
  | "codex_priority_sqlite"
  | "pi_sessions";

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

export interface PriorityTierEvidence {
  match_key: string;
  tier: "base" | "priority" | "unknown";
  confidence: "exact" | "inferred" | "unmatched";
  warning_code?: WarningCode;
}

export interface SessionUsageRecord extends TokenUsage {
  dedupe_key: string;
  source_kind: LocalUsageSourceKind;
  occurred_at: Date;
  local_date: string;
  model: string;
  model_alias?: string;
  long_context: boolean | "unknown";
  priority_tier: "base" | "priority" | "unknown";
  pricing_known: boolean;
}

export interface CostWindow {
  name: "today" | "last_7_days" | "last_30_days";
  start: string;
  end: string;
}

export interface CostAggregationResult {
  records: SessionUsageRecord[];
  sources: LocalUsageSourceStatus[];
  warnings: CollectorWarning[];
}

export interface AggregateSnapshot {
  schema_version: typeof AGGREGATE_SCHEMA_VERSION;
  machine_id: string;
  machine_label: string;
  generated_at: string;
  periods: {
    today: UsagePeriod;
    last_7_days: UsagePeriod;
    last_30_days: UsagePeriod;
  };
  daily: DailyUsage[];
  models: ModelUsage[];
  collector: {
    version: string;
    source: "codexbar-local-cost";
    codex_home: "default" | "custom";
    cost_engine_version: string;
    sources: LocalUsageSourceStatus[];
    warnings: CollectorWarning[];
  };
}

export interface CollectorCredential {
  collector_token: string;
  api_base_url: string;
  machine_id: string;
  machine_label: string;
  upload_interval_minutes: number;
}
