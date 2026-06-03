import { describe, expect, it } from "vitest";
import { estimateUsageCost, findPricingModel, normalizeEstimateModelName } from "../../src/pricing/index.js";

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

    expect(estimate.cost_status).toBe("known");
    expect(estimate.estimated_cost_usd).toBe(7.1175);
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

  it("applies Claude tiered long-context rates at the CodexBar boundary", () => {
    const estimate = estimateUsageCost([
      {
        model: "claude-sonnet-4-6",
        input_tokens: 200_010,
        cached_input_tokens: 5,
        output_tokens: 5,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 5
      }
    ]);

    expect(estimate.cost_status).toBe("known");
    expect(estimate.estimated_cost_usd).toBe(0.600155);
  });

  it("preserves Claude threshold pricing per request instead of aggregating first", () => {
    const estimate = estimateUsageCost([
      {
        model: "claude-sonnet-4-6",
        input_tokens: 150_000,
        cached_input_tokens: 0,
        output_tokens: 0
      },
      {
        model: "claude-sonnet-4-6",
        input_tokens: 150_000,
        cached_input_tokens: 0,
        output_tokens: 0
      }
    ]);
    const aggregateFirst = estimateUsageCost([
      {
        model: "claude-sonnet-4-6",
        input_tokens: 300_000,
        cached_input_tokens: 0,
        output_tokens: 0
      }
    ]);

    expect(estimate.estimated_cost_usd).toBe(0.9);
    expect(aggregateFirst.estimated_cost_usd).toBe(1.2);
  });
});
