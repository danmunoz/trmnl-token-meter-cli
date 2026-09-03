import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { SourceProvider } from "../types.js";

const execFileAsync = promisify(execFile);

// `codexbar cost` prices Codex, Claude, Cursor, and Antigravity. Only the two
// providers this collector already models are requested; asking for the others
// would pull in accounts the user never enabled here.
export const CODEXBAR_COST_PROVIDERS: readonly SourceProvider[] = ["codex", "claude"];

// Same discovery order the published CodexBar consumers use: an explicit override
// first, then PATH, then the locations the in-app "Install CLI" step symlinks.
const WELL_KNOWN_BINARY_PATHS = [
  "/opt/homebrew/bin/codexbar",
  "/usr/local/bin/codexbar",
  "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI"
];

export const CODEXBAR_DEFAULT_DAYS = 30;
export const CODEXBAR_DEFAULT_TIMEOUT_MS = 180_000;

const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * The subset of `codexbar cost --format json` this collector reads.
 *
 * Everything else in that payload stays on the machine. In particular `projects[]`
 * carries workspace names and absolute repository paths, and is never parsed,
 * copied, or logged here.
 */
export interface CodexBarModelBreakdown {
  modelName: string;
  totalTokens: number;
  cost: number | null;
}

export interface CodexBarDaily {
  date: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  totalTokens: number;
  totalCost: number | null;
  modelBreakdowns: CodexBarModelBreakdown[];
}

/** Token lanes that sum exactly to a day's `totalTokens`, with cache lanes broken out. */
export interface CodexBarLanes {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reconciled: boolean;
}

export interface CodexBarCoverage {
  priced: number;
  estimated: number;
  unpriced: number;
  unmetered: number;
}

export interface CodexBarProviderCost {
  provider: string;
  source: string | null;
  provenance: string | null;
  coverage: CodexBarCoverage | null;
  daily: CodexBarDaily[];
  errorMessage: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const nonNegativeInt = (value: unknown): number => {
  const parsed = finiteNumber(value);
  return parsed === null ? 0 : Math.max(0, Math.floor(parsed));
};

const nonNegativeCost = (value: unknown): number | null => {
  const parsed = finiteNumber(value);
  return parsed === null || parsed < 0 ? null : parsed;
};

const trimmedString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

// CodexBar dates are local calendar days already ("2026-08-31"), matching the
// local_date keys this collector windows on.
const localDateString = (value: unknown): string | null => {
  const text = trimmedString(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};

const parseCoverage = (value: unknown): CodexBarCoverage | null => {
  if (!isRecord(value)) return null;
  return {
    priced: nonNegativeInt(value.priced),
    estimated: nonNegativeInt(value.estimated),
    unpriced: nonNegativeInt(value.unpriced),
    unmetered: nonNegativeInt(value.unmetered)
  };
};

const parseModelBreakdowns = (value: unknown): CodexBarModelBreakdown[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const modelName = trimmedString(entry.modelName);
    if (!modelName) return [];
    return [
      {
        modelName,
        totalTokens: nonNegativeInt(entry.totalTokens),
        cost: nonNegativeCost(entry.cost)
      }
    ];
  });
};

const parseDaily = (value: unknown): CodexBarDaily[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const date = localDateString(entry.date);
    if (!date) return [];
    return [
      {
        date,
        inputTokens: nonNegativeInt(entry.inputTokens),
        cacheReadTokens: nonNegativeInt(entry.cacheReadTokens),
        cacheCreationTokens: nonNegativeInt(entry.cacheCreationTokens),
        outputTokens: nonNegativeInt(entry.outputTokens),
        totalTokens: nonNegativeInt(entry.totalTokens),
        totalCost: nonNegativeCost(entry.totalCost),
        modelBreakdowns: parseModelBreakdowns(entry.modelBreakdowns)
      }
    ];
  });
};

/**
 * Splits a day into cache-exclusive lanes that sum exactly to its `totalTokens`.
 *
 * CodexBar passes each provider's own token convention straight through, and the
 * two differ. Codex reports `inputTokens` inclusive of `cacheReadTokens`
 * (`input + output === total`), while Claude reports it exclusive of both cache
 * lanes (`input + cacheCreation + cacheRead + output === total`). Rather than
 * branching on the provider id — which would break the first time a provider
 * changes convention — the arithmetic that actually reconciles is detected.
 *
 * When neither reconciles, the reported lanes are kept and any shortfall against
 * `totalTokens` is placed in the input lane so the collector's own totals still
 * match what CodexBar reported, with `reconciled: false` recording the mismatch.
 */
export function codexBarDailyLanes(day: CodexBarDaily): CodexBarLanes {
  const { inputTokens, cacheReadTokens, cacheCreationTokens, outputTokens, totalTokens } = day;

  if (inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens === totalTokens) {
    return {
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      outputTokens,
      reconciled: true
    };
  }

  if (inputTokens + outputTokens === totalTokens && cacheReadTokens <= inputTokens) {
    return {
      inputTokens: inputTokens - cacheReadTokens - Math.min(cacheCreationTokens, inputTokens - cacheReadTokens),
      cacheReadTokens,
      cacheCreationTokens: Math.min(cacheCreationTokens, inputTokens - cacheReadTokens),
      outputTokens,
      reconciled: true
    };
  }

  const accountedFor = cacheReadTokens + cacheCreationTokens + outputTokens;
  return {
    inputTokens: Math.max(0, totalTokens - accountedFor),
    cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    reconciled: false
  };
}

const parseErrorMessage = (value: unknown): string | null => {
  if (!isRecord(value)) return null;
  return trimmedString(value.message);
};

/**
 * Maps one `codexbar cost --format json` document onto the fields this collector
 * reads. Unknown providers, extra keys, and future additions are ignored rather
 * than rejected, so a CodexBar release cannot break collection by growing its
 * payload.
 */
export function parseCodexBarCostPayload(raw: unknown): CodexBarProviderCost[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const provider = trimmedString(entry.provider);
    if (!provider) return [];
    return [
      {
        provider: provider.toLowerCase(),
        source: trimmedString(entry.source),
        provenance: trimmedString(entry.provenance),
        coverage: parseCoverage(entry.coverage),
        daily: parseDaily(entry.daily),
        errorMessage: parseErrorMessage(entry.error)
      }
    ];
  });
}

const isExecutable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const pathCandidates = (env: NodeJS.ProcessEnv): string[] => {
  const rawPath = env.PATH;
  if (!rawPath) return [];
  return rawPath
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => join(entry, "codexbar"));
};

/**
 * Resolves the CodexBar CLI, or null when the user does not have it installed.
 * A configured `CODEXBAR_BIN` that is not executable resolves to null rather than
 * silently falling through, so an explicit override never picks a different binary.
 */
export async function findCodexBarBinary(
  env: NodeJS.ProcessEnv = process.env,
  wellKnownPaths: readonly string[] = WELL_KNOWN_BINARY_PATHS
): Promise<string | null> {
  const override = env.CODEXBAR_BIN?.trim();
  if (override) return (await isExecutable(override)) ? override : null;

  for (const candidate of [...pathCandidates(env), ...wellKnownPaths]) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/** Extracts `0.56.2` from CodexBar's `--version` line (`CodexBar 0.56.2`). */
export function parseCodexBarVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return match?.[1] ?? null;
}

export async function readCodexBarVersion(
  binary: string,
  timeoutMs = 10_000
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    });
    return parseCodexBarVersion(stdout);
  } catch {
    return null;
  }
}

export interface CodexBarCostRequest {
  binary: string;
  providers: readonly SourceProvider[];
  days?: number;
  timeoutMs?: number;
  refresh?: boolean;
}

/**
 * `codexbar cost` takes a single `--provider <id|both|all>` value and silently
 * keeps only the last one when the flag is repeated, so a naive
 * `--provider codex --provider claude` would drop Codex usage without any error.
 * `both` is CodexBar's name for exactly the Codex + Claude pair.
 */
export function codexBarProviderArgument(
  providers: readonly SourceProvider[]
): string | null {
  const requested = CODEXBAR_COST_PROVIDERS.filter((provider) => providers.includes(provider));
  if (requested.length === 0) return null;
  return requested.length === CODEXBAR_COST_PROVIDERS.length ? "both" : (requested[0] as string);
}

/**
 * Runs one `codexbar cost` scan and returns its parsed payload.
 *
 * `--refresh` and an explicit `--days` are both required for a trustworthy window:
 * a plain `cost --json` answers from CodexBar's cache, which can still be warming
 * or cover a shorter period while reporting itself as a complete window.
 */
export async function runCodexBarCost(
  request: CodexBarCostRequest
): Promise<CodexBarProviderCost[]> {
  const providerArgument = codexBarProviderArgument(request.providers);
  if (!providerArgument) return [];

  const days = request.days ?? CODEXBAR_DEFAULT_DAYS;
  const args = ["cost", "--format", "json", "--days", String(days), "--json-only"];
  if (request.refresh ?? true) args.push("--refresh");
  args.push("--provider", providerArgument);

  const { stdout } = await execFileAsync(request.binary, args, {
    timeout: request.timeoutMs ?? CODEXBAR_DEFAULT_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    // The scan is local-only; keep the child from inheriting anything it does not need.
    env: { ...process.env, NO_COLOR: "1" }
  });

  return parseCodexBarCostPayload(JSON.parse(stdout) as unknown);
}
