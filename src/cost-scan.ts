import type { CollectorConfig } from "./config.js";
import { readCodexArchiveSource } from "./cost-sources/codex-archive.js";
import { readCodexSessionSource } from "./cost-sources/codex-sessions.js";
import { readPiSessionSource } from "./cost-sources/pi-sessions.js";
import { readPriorityEvidence } from "./cost-sources/priority-sqlite.js";
import type { CostAggregationResult } from "./types.js";
import { mergeWarnings } from "./warnings.js";

function applyPriorityEvidence(
  records: CostAggregationResult["records"],
  evidence: Awaited<ReturnType<typeof readPriorityEvidence>>["evidence"]
): CostAggregationResult["records"] {
  if (evidence.length === 0) return records;
  const byKey = new Map(evidence.map((item) => [item.match_key, item]));
  return records.map((record) => {
    const match = byKey.get(record.dedupe_key) ?? byKey.get(record.dedupe_key.split(":")[0] ?? "");
    return match ? { ...record, priority_tier: match.tier } : record;
  });
}

export async function scanLocalCostSources(config: CollectorConfig): Promise<CostAggregationResult> {
  const [sessions, archives, priority, pi] = await Promise.all([
    readCodexSessionSource(config),
    readCodexArchiveSource(config),
    readPriorityEvidence(config),
    readPiSessionSource(config)
  ]);

  return {
    records: applyPriorityEvidence(
      [...sessions.records, ...archives.records, ...pi.records],
      priority.evidence
    ),
    sources: [sessions.status, archives.status, priority.status, pi.status],
    warnings: mergeWarnings([
      ...sessions.warnings,
      ...archives.warnings,
      ...priority.warnings,
      ...pi.warnings
    ])
  };
}
