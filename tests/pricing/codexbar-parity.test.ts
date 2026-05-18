import { describe, expect, it } from "vitest";
import {
  codexBarPricingCatalogVersion,
  estimateUsageCost,
  findPricingModel,
  roundUsd
} from "../../src/pricing/index.js";

describe("CodexBar parity pricing", () => {
  it("uses supported Codex model-specific prices", () => {
    expect(findPricingModel("gpt-5.5")?.price.inputUsdPerMillion).toBe(5);
    expect(findPricingModel("gpt-5")?.price.outputUsdPerMillion).toBe(10);
    expect(findPricingModel("gpt-5.4-codex")?.id).toBe("gpt-5.4");
    expect(findPricingModel("gpt-5.3-codex")?.price.cachedInputUsdPerMillion).toBe(0.175);
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

  it("applies long-context and priority modifiers", () => {
    const base = estimateUsageCost([
      { model: "gpt-5.5", input_tokens: 1_000_000, cached_input_tokens: 0, output_tokens: 1_000_000 }
    ]);
    const modified = estimateUsageCost([
      {
        model: "gpt-5.5",
        input_tokens: 1_000_000,
        cached_input_tokens: 0,
        output_tokens: 1_000_000,
        long_context: true,
        priority_tier: "priority"
      }
    ]);

    expect(base.estimated_cost_usd).toBe(35);
    expect(modified.estimated_cost_usd).toBe(110);
  });
});
