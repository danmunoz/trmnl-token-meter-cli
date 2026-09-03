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
import { readClaudeProjectSource } from "../../src/cost-sources/claude-projects.js";
import { loadConfig } from "../../src/config.js";

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
// so exact equality is the wrong assertion. Scaling is linear, so the ratio it is
// applied to is scale-invariant and a purely relative bound stays meaningful at any
// scale — far tighter than real catalog drift (the rate changes this check is built
// to find run 20%+) and far looser than rounding.
const RELATIVE_TOLERANCE = 0.005;

// Days too cheap to judge: at these sizes six-decimal rounding and the scaling
// below are a large enough share of the figure to produce noise either way.
const MIN_COMPARABLE_USD = 0.25;

// Every long-context threshold in the catalog is at or above 200K prompt tokens.
// Comparisons are scaled under that bound; see `scaleToBaseRates`.
const BASE_RATE_PROMPT_CEILING = 150_000;

/**
 * How far below CodexBar a base-rate day may fall before it stops looking like a
 * per-request surcharge and starts looking like a stale rate.
 *
 * With the cache TTL split supplied, every comparable day on the machine this was
 * developed against lands between 0.9986x and 1.0001x, so the remaining headroom is
 * for days that genuinely contain long-context requests — which a day aggregate
 * cannot represent and which only ever make CodexBar's figure larger.
 */
const UNDERPRICING_FLOOR = 0.95;

let binary: string | null = null;
let version: string | null = null;
let payloads: CodexBarProviderCost[] = [];
let scanError: Error | null = null;

/**
 * Share of each Claude day's cache-creation lane written with a 1-hour TTL.
 *
 * CodexBar's cost JSON reports a day's cache creation as one number, so the oracle
 * cannot see the TTL split that both engines actually price on — and Claude days
 * would sit ~5-28% under CodexBar for that reason alone, deep enough to hide real
 * drift on the models that dominate spend. The split is read back from the same
 * transcripts CodexBar scanned. A share is used rather than absolute tokens so a
 * small difference in what each scanner deduplicated cannot skew it.
 */
const oneHourCacheShare = new Map<string, number>();

const shareKey = (date: string, model: string): string => `${date}:${model}`;

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

  const totals = new Map<string, { oneHour: number; total: number }>();
  for (const record of (await readClaudeProjectSource(loadConfig())).records) {
    const total = record.cache_creation_input_tokens ?? 0;
    if (total === 0) continue;
    const key = shareKey(record.local_date, record.model);
    const entry = totals.get(key) ?? { oneHour: 0, total: 0 };
    entry.oneHour += record.cache_creation_1h_input_tokens ?? 0;
    entry.total += total;
    totals.set(key, entry);
  }
  for (const [key, { oneHour, total }] of totals) {
    oneHourCacheShare.set(key, oneHour / total);
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
 * A day is an aggregate of many requests, but the estimator applies full-row
 * long-context repricing whenever a single row's prompt crosses the threshold.
 * Feeding a whole day in as one row would therefore reprice usage that CodexBar
 * priced per request at base rates, and report the artifact as drift. Base-rate
 * pricing is linear, so scaling both sides by the same factor compares the rate
 * cards without tripping the threshold.
 *
 * The whole prompt is scaled, not just the input lane: a long-context threshold
 * counts cache reads and cache writes too, and a cache-heavy day clears it on
 * those lanes alone.
 */
const scaleToBaseRates = (promptTokens: number): number =>
  promptTokens > BASE_RATE_PROMPT_CEILING ? BASE_RATE_PROMPT_CEILING / promptTokens : 1;

interface ComparedDay {
  provider: string;
  day: (typeof payloads)[number]["daily"][number];
  model: string;
  ours: number | null;
  theirs: number;
  scale: number;
}

/**
 * Days where this collector and CodexBar can be compared at all.
 *
 * Only single-model days qualify: CodexBar reports token lanes per day but cost
 * per model, so a mixed day cannot be attributed exactly. Lanes are then scaled
 * below the catalog's long-context thresholds, because base-rate pricing is linear
 * and feeding a whole day in as one row would otherwise trip full-row repricing
 * that CodexBar never applied.
 */
const comparableDays = (): ComparedDay[] =>
  payloads.flatMap((payload) =>
    payload.daily.flatMap((day) => {
      if (day.modelBreakdowns.length !== 1 || day.totalCost === null) return [];
      const breakdown = day.modelBreakdowns[0];
      if (!breakdown || breakdown.totalTokens !== day.totalTokens) return [];
      if (!findPricingModel(breakdown.modelName)) return [];
      const lanes = codexBarDailyLanes(day);
      if (!lanes.reconciled || lanes.inputTokens === 0) return [];
      if (day.totalCost < MIN_COMPARABLE_USD) return [];

      const promptTokens =
        lanes.inputTokens + lanes.cacheReadTokens + lanes.cacheCreationTokens;
      const scale = scaleToBaseRates(promptTokens);
      const scaled = (tokens: number): number => Math.round(tokens * scale);
      const cacheCreation = scaled(lanes.cacheCreationTokens);
      const share = oneHourCacheShare.get(shareKey(day.date, breakdown.modelName)) ?? 0;
      const estimate = estimateUsageCost([
        {
          model: breakdown.modelName,
          input_tokens: scaled(lanes.inputTokens),
          cached_input_tokens: scaled(lanes.cacheReadTokens),
          output_tokens: scaled(lanes.outputTokens),
          cache_read_input_tokens: scaled(lanes.cacheReadTokens),
          cache_creation_input_tokens: cacheCreation,
          cache_creation_1h_input_tokens: Math.round(cacheCreation * share),
          long_context: false,
          priority_tier: "base"
        }
      ]);

      return [
        {
          provider: payload.provider,
          day,
          model: breakdown.modelName,
          ours: estimate.estimated_cost_usd,
          theirs: day.totalCost * scale,
          scale
        }
      ];
    })
  );

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

  /**
   * Comparison is deliberately one-sided.
   *
   * CodexBar prices each request; this check can only feed it a whole day. Every
   * per-request effect CodexBar applies — long-context tiers above 200K/272K, the
   * 1-hour cache-write rate, API Fast — costs *more* than the base rate, and none
   * of them are visible in a day aggregate. A day priced at flat base rates is
   * therefore a lower bound on CodexBar's figure, and being under it proves
   * nothing about the catalog.
   *
   * Being *over* it does. There is no per-request effect that makes CodexBar
   * cheaper than base rates, so exceeding CodexBar means the catalog's rates are
   * too high — which is exactly the failure this suite was built to find, and
   * exactly what stale gpt-5.6 Sol, Terra, and Luna rates looked like (1.25x-5x).
   *
   * Solving real single-model days for per-lane rates confirms the asymmetry is
   * structural rather than drift: a four-lane fit against claude-opus-5 days
   * returns a negative input rate and only reproduces the days it was fitted on.
   */
  it(
    "never prices tokens above CodexBar",
    ({ skip }) => {
      if (!requireOracle(skip)) return;

      const drift = comparableDays().flatMap(({ provider, day, model, ours, theirs, scale }) => {
        if (ours === null) {
          return [`${provider} ${day.date} ${model}: no local price, CodexBar $${theirs}`];
        }
        if (ours - theirs <= theirs * RELATIVE_TOLERANCE) return [];
        return [
          `${provider} ${day.date} ${model}: ours $${ours.toFixed(6)} exceeds CodexBar $${theirs.toFixed(6)} (${(ours / theirs).toFixed(3)}x, scaled ${scale.toFixed(4)})`
        ];
      });

      expect(
        drift,
        `catalog rates above CodexBar ${version} — these are stale prices, not aggregation artifacts`
      ).toEqual([]);
    },
    ORACLE_TIMEOUT_MS
  );

  it(
    "stays within a plausible band below CodexBar",
    ({ skip }) => {
      if (!requireOracle(skip)) return;

      // Per-request surcharges explain a modest shortfall. A large one means the
      // catalog's rates are too low, which the one-sided check above cannot see.
      const shortfall = comparableDays().flatMap(({ provider, day, model, ours, theirs }) => {
        if (ours === null || theirs === 0) return [];
        const ratio = ours / theirs;
        if (ratio >= UNDERPRICING_FLOOR) return [];
        return [
          `${provider} ${day.date} ${model}: ours $${ours.toFixed(6)} is ${ratio.toFixed(3)}x CodexBar $${theirs.toFixed(6)}`
        ];
      });

      expect(
        shortfall,
        `catalog rates far below CodexBar ${version} (floor ${UNDERPRICING_FLOOR}x)`
      ).toEqual([]);
    },
    ORACLE_TIMEOUT_MS
  );
});
