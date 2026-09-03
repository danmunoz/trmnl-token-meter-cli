import { describe, expect, it } from "vitest";
import {
  estimateUsageCost,
  findPricingModel,
  normalizeEstimateModelName,
  roundUsd
} from "../../src/pricing/index.js";

describe("Claude pricing parity", () => {
  it("normalizes Claude provider prefixes and dated variants", () => {
    expect(normalizeEstimateModelName("anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
      "claude-sonnet-4-5"
    );
    expect(normalizeEstimateModelName("claude-sonnet-4-20250514")).toBe(
      "claude-sonnet-4-20250514"
    );
    expect(normalizeEstimateModelName("claude-sonnet-4-6-20260219")).toBe(
      "claude-sonnet-4-6"
    );
    expect(normalizeEstimateModelName("claude-opus-4-8-20260601")).toBe(
      "claude-opus-4-8"
    );
    expect(normalizeEstimateModelName("anthropic.us-east-1.claude-sonnet-4-6-v1:0")).toBe(
      "claude-sonnet-4-6"
    );
  });

  it("prices Claude cache creation and cache read as separate lanes", () => {
    const estimate = estimateUsageCost([
      {
        model: "claude-sonnet-4-5-20250929",
        input_tokens: 1_000_000,
        cached_input_tokens: 100_000,
        output_tokens: 100_000,
        cache_creation_input_tokens: 50_000,
        cache_read_input_tokens: 100_000
      }
    ]);

    // The 1.15M-token prompt is over the 200K threshold, and Claude long context
    // reprices the whole request rather than only the tokens past the boundary.
    expect(estimate.cost_status).toBe("known");
    expect(estimate.estimated_cost_usd).toBe(
      roundUsd(1_000_000 * 6e-6 + 100_000 * 6e-7 + 50_000 * 7.5e-6 + 100_000 * 2.25e-5)
    );
  });

  it("prices CodexBar Claude Opus 4.7 regression rows", () => {
    const estimate = estimateUsageCost([
      {
        model: "claude-opus-4-7",
        input_tokens: 6,
        cached_input_tokens: 50_352,
        output_tokens: 3_922,
        cache_creation_input_tokens: 1_389,
        cache_read_input_tokens: 50_352
      }
    ]);

    expect(estimate.cost_status).toBe("known");
    expect(estimate.estimated_cost_usd).toBe(0.131937);
  });

  it("prices CodexBar Claude Opus 4.8 regression rows", () => {
    expect(findPricingModel("claude-opus-4-8")?.id).toBe("claude-opus-4-8");

    const estimate = estimateUsageCost([
      {
        model: "claude-opus-4-8",
        input_tokens: 6,
        cached_input_tokens: 50_352,
        output_tokens: 3_922,
        cache_creation_input_tokens: 1_389,
        cache_read_input_tokens: 50_352
      }
    ]);

    expect(estimate.cost_status).toBe("known");
    expect(estimate.estimated_cost_usd).toBe(0.131937);
  });

  it("reprices the whole Claude request past the CodexBar long-context boundary", () => {
    const estimate = estimateUsageCost([
      {
        model: "claude-sonnet-4-5",
        input_tokens: 200_010,
        cached_input_tokens: 5,
        output_tokens: 5,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 5
      }
    ]);

    expect(estimate.cost_status).toBe("known");
    expect(estimate.estimated_cost_usd).toBe(
      roundUsd(200_010 * 6e-6 + 5 * 6e-7 + 5 * 7.5e-6 + 5 * 2.25e-5)
    );
  });

  it("counts both cache lanes toward the Claude long-context threshold", () => {
    // The input lane alone is nowhere near the boundary; the prompt is over it only
    // once cache reads are counted, which is how the provider bills it.
    const overThreshold = estimateUsageCost([
      {
        model: "claude-sonnet-4-5",
        input_tokens: 10,
        cached_input_tokens: 199_995,
        output_tokens: 0,
        cache_creation_input_tokens: 10,
        cache_read_input_tokens: 199_995
      }
    ]);

    expect(overThreshold.estimated_cost_usd).toBe(
      roundUsd(10 * 6e-6 + 199_995 * 6e-7 + 10 * 7.5e-6)
    );
  });

  it("bills Claude one-hour cache writes at twice the input rate", () => {
    const fiveMinute = estimateUsageCost([
      {
        model: "claude-opus-5",
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_read_input_tokens: 0
      }
    ]);
    const oneHour = estimateUsageCost([
      {
        model: "claude-opus-5",
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_creation_1h_input_tokens: 1_000_000,
        cache_read_input_tokens: 0
      }
    ]);

    // Opus 5 input is $5/M, so 5-minute writes bill at 1.25x and 1-hour at 2x.
    expect(fiveMinute.estimated_cost_usd).toBe(6.25);
    expect(oneHour.estimated_cost_usd).toBe(10);
  });

  it("splits a mixed cache-creation lane by TTL", () => {
    const estimate = estimateUsageCost([
      {
        model: "claude-opus-5",
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000_000,
        cache_creation_1h_input_tokens: 600_000,
        cache_read_input_tokens: 0
      }
    ]);

    expect(estimate.estimated_cost_usd).toBe(roundUsd(600_000 * 1e-5 + 400_000 * 6.25e-6));
  });

  it("never bills more one-hour cache than the lane reported", () => {
    // The 1-hour count is a subset of cache creation, so a larger value is clamped
    // rather than inventing tokens.
    const estimate = estimateUsageCost([
      {
        model: "claude-opus-5",
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 1_000,
        cache_creation_1h_input_tokens: 9_999,
        cache_read_input_tokens: 0
      }
    ]);

    expect(estimate.estimated_cost_usd).toBe(roundUsd(1_000 * 1e-5));
  });

  it("preserves Claude threshold pricing per request instead of aggregating first", () => {
    const estimate = estimateUsageCost([
      {
        model: "claude-sonnet-4-5",
        input_tokens: 150_000,
        cached_input_tokens: 0,
        output_tokens: 0
      },
      {
        model: "claude-sonnet-4-5",
        input_tokens: 150_000,
        cached_input_tokens: 0,
        output_tokens: 0
      }
    ]);
    const aggregateFirst = estimateUsageCost([
      {
        model: "claude-sonnet-4-5",
        input_tokens: 300_000,
        cached_input_tokens: 0,
        output_tokens: 0
      }
    ]);

    // Two requests under the threshold stay at base rates; one request of the same
    // total size crosses it and reprices entirely, so the order of operations shows
    // up as a 2x difference rather than a rounding one.
    expect(estimate.estimated_cost_usd).toBe(0.9);
    expect(aggregateFirst.estimated_cost_usd).toBe(1.8);
  });

  it("prices claude-sonnet-4-6 as flat after the CodexBar long-context reprice", () => {
    expect(findPricingModel("claude-sonnet-4-6")?.price.thresholdTokens).toBeUndefined();

    const estimate = estimateUsageCost([
      {
        model: "claude-sonnet-4-6",
        input_tokens: 300_000,
        cached_input_tokens: 0,
        output_tokens: 0
      }
    ]);

    expect(estimate.cost_status).toBe("known");
    expect(estimate.estimated_cost_usd).toBe(0.9);
  });

  it("prices the claude-fable-5 model at its flat rates", () => {
    expect(findPricingModel("claude-fable-5")?.price.inputUsdPerMillion).toBe(10);

    const estimate = estimateUsageCost([
      {
        model: "claude-fable-5",
        input_tokens: 1_000,
        cached_input_tokens: 200,
        output_tokens: 500,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 200
      }
    ]);

    expect(estimate.cost_status).toBe("known");
    expect(estimate.estimated_cost_usd).toBe(
      roundUsd(1_000 * 1e-5 + 200 * 1e-6 + 100 * 1.25e-5 + 500 * 5e-5)
    );
  });
});
