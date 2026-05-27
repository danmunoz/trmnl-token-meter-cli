import { describe, expect, it } from "vitest";
import {
  codexBarPricingCatalogVersion,
  estimateUsageCost,
  findPricingModel,
  roundUsd
} from "../../src/pricing/index.js";

describe("CodexBar parity pricing", () => {
  it("uses supported Codex model-specific prices", () => {
    expect(findPricingModel("openai/gpt-5-codex")?.id).toBe("gpt-5-codex");
    expect(findPricingModel("gpt-5.1-codex-max")?.id).toBe("gpt-5.1-codex-max");
    expect(findPricingModel("gpt-5.2-codex")?.price.inputUsdPerMillion).toBe(1.75);
    expect(findPricingModel("gpt-5.5")?.price.inputUsdPerMillion).toBe(5);
    expect(findPricingModel("gpt-5")?.price.outputUsdPerMillion).toBe(10);
    expect(findPricingModel("gpt-5.4-pro-2026-03-05")?.id).toBe("gpt-5.4-pro");
    expect(findPricingModel("gpt-5.4-nano")?.price.cachedInputUsdPerMillion).toBe(0.02);
    expect(findPricingModel("gpt-5.3-codex")?.price.cachedInputUsdPerMillion).toBe(0.175);
    expect(findPricingModel("gpt-5.3-codex-spark")?.price.outputUsdPerMillion).toBe(0);
  });

  it("sums unrounded line items before deterministic aggregate rounding", () => {
    const estimate = estimateUsageCost([
      { model: "gpt-5.3-codex", input_tokens: 333, cached_input_tokens: 33, output_tokens: 101 },
      { model: "gpt-5.3-codex", input_tokens: 333, cached_input_tokens: 33, output_tokens: 101 }
    ]);

    expect(estimate.pricing_catalog_version).toBe(codexBarPricingCatalogVersion);
    expect(estimate.estimated_cost_usd).toBe(
      roundUsd(2 * ((300 / 1_000_000) * 1.75 + (33 / 1_000_000) * 0.175 + (101 / 1_000_000) * 14))
    );
  });

  it("applies CodexBar long-context rates to full Codex rows above threshold", () => {
    const atBoundary = estimateUsageCost([
      { model: "gpt-5.5", input_tokens: 272_000, cached_input_tokens: 0, output_tokens: 128_000 }
    ]);
    const aboveBoundary = estimateUsageCost([
      {
        model: "gpt-5.5",
        input_tokens: 272_001,
        cached_input_tokens: 200_000,
        output_tokens: 10
      }
    ]);

    expect(atBoundary.estimated_cost_usd).toBe(roundUsd(272_000 * 5e-6 + 128_000 * 3e-5));
    expect(aboveBoundary.estimated_cost_usd).toBe(
      roundUsd(72_001 * 1e-5 + 200_000 * 1e-6 + 10 * 4.5e-5)
    );
  });

  it("applies CodexBar model-specific priority pricing only within the priority input limit", () => {
    const priority = estimateUsageCost([
      {
        model: "gpt-5.5",
        input_tokens: 100,
        cached_input_tokens: 20,
        output_tokens: 10,
        priority_tier: "priority"
      }
    ]);
    const longContextPriority = estimateUsageCost([
      {
        model: "gpt-5.5",
        input_tokens: 272_001,
        cached_input_tokens: 0,
        output_tokens: 10,
        priority_tier: "priority"
      }
    ]);

    expect(priority.estimated_cost_usd).toBe(
      roundUsd(80 * 1.25e-5 + 20 * 1.25e-6 + 10 * 7.5e-5)
    );
    expect(longContextPriority.estimated_cost_usd).toBe(
      roundUsd(272_001 * 1e-5 + 10 * 4.5e-5)
    );
  });
});
