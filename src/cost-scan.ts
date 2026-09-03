import type { CollectorConfig } from "./config.js";
import { disabledSourceStatus, providerSourceKinds, SUPPORTED_PROVIDERS } from "./source-providers.js";
import { probeProviderStatuses } from "./source-availability.js";
import type {
  CostAggregationResult,
  LocalUsageSourceStatus,
  SourceProvider,
  LocalUsageSourceKind
} from "./types.js";
import { mergeWarnings } from "./warnings.js";
import { readCodexArchiveSource } from "./cost-sources/codex-archive.js";
import { readCodexSessionSource } from "./cost-sources/codex-sessions.js";
import { readClaudeProjectSource } from "./cost-sources/claude-projects.js";
import { readOpenCodeSqliteSource } from "./cost-sources/opencode-sqlite.js";
import { readPiSessionSource } from "./cost-sources/pi-sessions.js";
import { readPriorityEvidence } from "./cost-sources/priority-sqlite.js";
import { readCodexBarCostSource } from "./cost-sources/codexbar-cli.js";

interface ScanOptions {
  enabledProviders?: SourceProvider[];
}

function applyPriorityEvidence(
  records: CostAggregationResult["records"],
  evidence: Awaited<ReturnType<typeof readPriorityEvidence>>["evidence"]
): CostAggregationResult["records"] {
  if (evidence.length === 0) return records;
  const byKey = new Map(evidence.map((item) => [item.match_key, item]));
  return records.map((record) => {
    const match =
      (record.turn_id ? byKey.get(record.turn_id) : undefined) ??
      byKey.get(record.dedupe_key) ??
      byKey.get(record.dedupe_key.split(":")[0] ?? "");
    return match
      ? {
          ...record,
          priority_tier: match.tier,
          ...(match.model ? { model: match.model, model_alias: record.model } : {})
        }
      : record;
  });
}

function disabledKindsByProvider(): Map<LocalUsageSourceKind, LocalUsageSourceStatus> {
  const statuses = new Map<LocalUsageSourceKind, LocalUsageSourceStatus>();
  for (const provider of SUPPORTED_PROVIDERS) {
    for (const kind of providerSourceKinds[provider]) {
      statuses.set(kind, disabledSourceStatus(kind));
    }
  }
  return statuses;
}

export async function scanLocalCostSources(
  config: CollectorConfig,
  options: ScanOptions = {}
): Promise<CostAggregationResult> {
  const enabledProviders = options.enabledProviders ?? config.enabledProviders ?? ["codex"];
  const shouldRead = (provider: SourceProvider): boolean => enabledProviders.includes(provider);

  const providerStatuses = await probeProviderStatuses(config);

  // The CodexBar scan runs alongside the local scanners rather than gating them:
  // its result is only known at the end, and a failed or absent CodexBar has to
  // leave a complete local scan behind it.
  const [codexBar, piResult, codexTask, opencodeTask, claudeTask] = await Promise.all([
    readCodexBarCostSource(config, enabledProviders),
    readPiSessionSource(config),
    shouldRead("codex")
      ? Promise.all([readCodexSessionSource(config), readCodexArchiveSource(config), readPriorityEvidence(config)])
      : Promise.resolve(null),
    shouldRead("opencode") ? readOpenCodeSqliteSource(config) : Promise.resolve(null),
    shouldRead("claude") ? readClaudeProjectSource(config) : Promise.resolve(null)
  ]);

  const [sessionRead, archiveRead, priorityRead] = codexTask ?? [];
  const sourceStatuses = disabledKindsByProvider();
  const addSourceStatus = (source: { status: LocalUsageSourceStatus } | null | undefined): void => {
    if (!source) return;
    sourceStatuses.set(source.status.kind, source.status);
  };
  addSourceStatus(sessionRead);
  addSourceStatus(archiveRead);
  addSourceStatus(priorityRead);
  addSourceStatus(opencodeTask);
  addSourceStatus(claudeTask);

  const sources = [...sourceStatuses.values(), piResult.status, codexBar.status];

  // Where CodexBar priced a provider, its rows replace the local scan for that
  // provider so the two never double count. The local scan still ran, and its
  // source statuses still report what a fallback would have found.
  const pricedByCodexBar = new Set(codexBar.providers);
  const localRecords = applyPriorityEvidence(
    [...(sessionRead?.records ?? []), ...(archiveRead?.records ?? []), ...(opencodeTask?.records ?? []), ...(claudeTask?.records ?? []), ...piResult.records],
    priorityRead?.evidence ?? []
  ).filter((record) => !pricedByCodexBar.has(record.source_provider));

  const records = [...localRecords, ...codexBar.records];

  const warnings = mergeWarnings(
    [
      ...piResult.warnings,
      ...(sessionRead?.warnings ?? []),
      ...(archiveRead?.warnings ?? []),
      ...(priorityRead?.warnings ?? []),
      ...(opencodeTask?.warnings ?? []),
      ...(claudeTask?.warnings ?? []),
      ...codexBar.warnings
    ]
  );

  return {
    records,
    sources,
    warnings,
    providerStatuses,
    codexBar: {
      available: codexBar.available,
      version: codexBar.version,
      providers: codexBar.providers
    }
  };
}
