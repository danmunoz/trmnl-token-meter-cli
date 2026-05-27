import type { CollectorWarning, WarningCode, WarningSeverity } from "./types.js";

const severityByCode: Record<WarningCode, WarningSeverity> = {
  codex_sessions_missing: "warning",
  codex_archived_sessions_missing: "warning",
  malformed_records_skipped: "warning",
  unknown_pricing: "info",
  long_context_pricing_unknown: "info",
  priority_evidence_missing: "warning",
  priority_evidence_unreadable: "warning",
  priority_evidence_malformed: "warning",
  opencode_sqlite_missing: "warning",
  opencode_sqlite_unreadable: "warning",
  opencode_sqlite_malformed: "warning",
  pi_sessions_disabled: "info",
  pi_sessions_missing: "info",
  pi_sessions_malformed: "warning",
  duplicate_records_skipped: "warning",
  stale_upload: "warning",
  upload_rejected: "error"
};

export function warning(code: WarningCode, count?: number): CollectorWarning {
  return count === undefined
    ? { code, severity: severityByCode[code] }
    : { code, severity: severityByCode[code], count };
}

export function mergeWarnings(warnings: CollectorWarning[]): CollectorWarning[] {
  const merged = new Map<WarningCode, CollectorWarning>();
  for (const item of warnings) {
    const existing = merged.get(item.code);
    if (!existing) {
      merged.set(item.code, { ...item });
      continue;
    }
    existing.count = (existing.count ?? 1) + (item.count ?? 1);
  }
  return [...merged.values()];
}

export function warningCodes(warnings: readonly CollectorWarning[]): WarningCode[] {
  return [...new Set(warnings.map((item) => item.code))].sort();
}
