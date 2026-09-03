import { beforeAll, describe, expect, it } from "vitest";
import {
  CODEXBAR_COST_PROVIDERS,
  codexBarDailyLanes,
  findCodexBarBinary,
  readCodexBarVersion,
  runCodexBarCost,
  type CodexBarProviderCost
} from "../../src/cost-sources/codexbar-cli.js";
import { estimateUsageCost, findPricingModel } from "../../src/pricing/index.js";

/**
 * Differential check of this collector's ported pricing catalog against the
 * CodexBar release it was ported from.
 *
 * `src/pricing/models.ts` is a hand-maintained port, so it drifts silently every
 * time a provider ships a model or changes a rate. This suite uses a local
 * CodexBar install as the oracle: it fails when CodexBar prices a model this
 * collector cannot, and when the two disagree on the price of the same tokens.
 *
 * Opt-in with `CODEXBAR_ORACLE=on` (`pnpm test:oracle`), because it reads whatever
 * usage history the machine happens to have. That makes it a maintenance tool for
 * catalog drift, not a deterministic gate for `pnpm test`. It skips itself when
 * CodexBar is not installed.
 *
 * The scan deliberately runs without `--refresh`: cached history is fine for
 * comparing prices rather than window completeness, and a cold scan takes minutes.
 */

const ORACLE_DAYS = 30;
const ORACLE_TIMEOUT_MS = 240_000;

// CodexBar sums unrounded line items and this collector rounds to six decimals,
// so exact equality is the wrong assertion. These bounds are far tighter than any
// real catalog drift (the rate changes this check is built to find run 20%+) and
// far looser than float noise or the scaling below.
const ABSOLUTE_TOLERANCE_USD = 0.01;
const RELATIVE_TOLERANCE = 0.005;

// Every full-row long-context threshold in the catalog is at or above 200K input
// tokens. Comparisons are scaled under that bound; see `scaleToBaseRates`.
const BASE_RATE_INPUT_CEILING = 100_000;

let binary: string | null = null;
let version: string | null = null;
let payloads: CodexBarProviderCost[] = [];
let scanError: Error | null = null;

const oracleRequested = (): boolean => process.env.CODEXBAR_ORACLE === "on";

beforeAll(async () => {
  if (!oracleRequested()) return;
  binary = await findCodexBarBinary();
  if (!binary) return;
  version = await readCodexBarVersion(binary);
  try {
    payloads = await runCodexBarCost({
      binary,
      providers: CODEXBAR_COST_PROVIDERS,
      days: ORACLE_DAYS,
      refresh: false,
      timeoutMs: ORACLE_TIMEOUT_MS
    });
  } catch (error) {
    scanError = error instanceof Error ? error : new Error(String(error));
  }
}, ORACLE_TIMEOUT_MS + 30_000);

// Gating happens inside each test rather than on `describe`, because whether the
// oracle exists is only known after `beforeAll` has looked for it.
const requireOracle = (skip: (note?: string) => void): boolean => {
  if (!oracleRequested()) {
    skip("set CODEXBAR_ORACLE=on to run the CodexBar pricing oracle");
    return false;
  }
  if (!binary) {
    skip("CodexBar is not installed on this machine");
    return false;
  }
  if (scanError) {
    skip(`codexbar cost failed: ${scanError.message}`);
    return false;
  }
  return true;
};

/**
 * Scales a day's lanes below the catalog's long-context thresholds.
 *
 * A day is an aggregate of many requests, but this collector's estimator applies
 * full-row long-context repricing whenever a single row's input lane crosses the
 * threshold. Feeding a whole day in as one row would therefore reprice usage that
 * CodexBar priced per request at base rates, and report the artifact as drift.
 * Base-rate pricing is linear, so scaling both sides by the same factor compares
 * the rate cards without tripping the threshold.
 */
const scaleToBaseRates = (inputTokens: number): number =>
  inputTokens > BASE_RATE_INPUT_CEILING ? BASE_RATE_INPUT_CEILING / inputTokens : 1;

describe("CodexBar pricing oracle", () => {
  it(
    "prices every model CodexBar prices",
    ({ skip }) => {
      if (!requireOracle(skip)) return;

      const missing = new Map<string, number>();
      for (const payload of payloads) {
        for (const day of payload.daily) {
          for (const breakdown of day.modelBreakdowns) {
            // Only models CodexBar itself put a price on are in scope. An unpriced
            // model is a gap upstream, not drift in this catalog.
            if (breakdown.cost === null || breakdown.totalTokens === 0) continue;
            if (findPricingModel(breakdown.modelName)) continue;
            missing.set(
              breakdown.modelName,
              (missing.get(breakdown.modelName) ?? 0) + breakdown.totalTokens
            );
          }
        }
      }

      const report = [...missing.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([model, tokens]) => `${model} (${tokens.toLocaleString()} tokens)`)
        .join(", ");

      expect(
        [...missing.keys()],
        `CodexBar ${version} prices models missing from src/pricing/models.ts: ${report}`
      ).toEqual([]);
    },
    ORACLE_TIMEOUT_MS
  );

  it(
    "agrees with CodexBar on the price of the same tokens",
    ({ skip }) => {
      if (!requireOracle(skip)) return;

      // Only single-model days are comparable: CodexBar reports token lanes per
      // day but cost per model, so a mixed day cannot be attributed exactly.
      const comparable = payloads.flatMap((payload) =>
        payload.daily.flatMap((day) => {
          if (day.modelBreakdowns.length !== 1 || day.totalCost === null) return [];
          const breakdown = day.modelBreakdowns[0];
          if (!breakdown || breakdown.totalTokens !== day.totalTokens) return [];
          if (!findPricingModel(breakdown.modelName)) return [];
          const lanes = codexBarDailyLanes(day);
          if (!lanes.reconciled || lanes.inputTokens === 0) return [];
          return [{ provider: payload.provider, day, model: breakdown.modelName, lanes }];
        })
      );

      const drift = comparable.flatMap(({ provider, day, model, lanes }) => {
        const scale = scaleToBaseRates(lanes.inputTokens);
        const scaled = (tokens: number): number => Math.round(tokens * scale);
        const estimate = estimateUsageCost([
          {
            model,
            input_tokens: scaled(lanes.inputTokens),
            cached_input_tokens: scaled(lanes.cacheReadTokens),
            output_tokens: scaled(lanes.outputTokens),
            cache_read_input_tokens: scaled(lanes.cacheReadTokens),
            cache_creation_input_tokens: scaled(lanes.cacheCreationTokens),
            long_context: false,
            priority_tier: "base"
          }
        ]);

        const ours = estimate.estimated_cost_usd;
        const theirs = (day.totalCost ?? 0) * scale;
        if (ours === null) {
          return [`${provider} ${day.date} ${model}: no local price, CodexBar $${theirs}`];
        }
        const difference = Math.abs(ours - theirs);
        const tolerance = Math.max(ABSOLUTE_TOLERANCE_USD, theirs * RELATIVE_TOLERANCE);
        if (difference <= tolerance) return [];
        const ratio = theirs === 0 ? Number.NaN : ours / theirs;
        return [
          `${provider} ${day.date} ${model}: ours $${ours.toFixed(6)} vs CodexBar $${theirs.toFixed(6)} (${ratio.toFixed(3)}x, scaled ${scale.toFixed(4)})`
        ];
      });

      expect(
        drift,
        `pricing drift against CodexBar ${version} across ${comparable.length} single-model days`
      ).toEqual([]);
    },
    ORACLE_TIMEOUT_MS
  );
});
