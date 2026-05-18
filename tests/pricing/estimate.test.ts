import { describe, expect, it } from "vitest";
import { estimateUsageCost, findPricingModel } from "../../src/pricing/index.js";

describe("pricing catalog", () => {
  it("matches known model aliases", () => {
    expect(findPricingModel("gpt-5.5-2026-04-23")?.id).toBe("gpt-5.5");
  });
});

describe("estimateUsageCost", () => {
  it("returns a known cost for fully priced usage", () => {
    const estimate = estimateUsageCost([
      {
        model: "gpt-5",
        input_tokens: 1_000_000,
        cached_input_tokens: 100_000,
        output_tokens: 100_000
      }
    ]);

    expect(estimate.cost_status).toBe("known");
    expect(estimate.estimated_cost_usd).toBe(2.1375);
  });

  it("returns partial when some models are unknown", () => {
    const estimate = estimateUsageCost([
      { model: "gpt-5-mini", input_tokens: 1000, cached_input_tokens: 0, output_tokens: 1000 },
      {
        model: "private-local-model",
        input_tokens: 1000,
        cached_input_tokens: 0,
        output_tokens: 1000
      }
    ]);

    expect(estimate.cost_status).toBe("partial");
    expect(estimate.estimated_cost_usd).toBeGreaterThan(0);
    expect(estimate.unknown_models).toEqual(["private-local-model"]);
  });

  it("returns unknown when no model can be priced", () => {
    const estimate = estimateUsageCost([
      { model: "missing", input_tokens: 1000, cached_input_tokens: 0, output_tokens: 1000 }
    ]);

    expect(estimate.cost_status).toBe("unknown");
    expect(estimate.estimated_cost_usd).toBeNull();
  });

  it("returns disabled when cost display is disabled", () => {
    const estimate = estimateUsageCost(
      [{ model: "gpt-5", input_tokens: 1000, cached_input_tokens: 0, output_tokens: 1000 }],
      { showCost: false }
    );

    expect(estimate.cost_status).toBe("disabled");
    expect(estimate.estimated_cost_usd).toBeNull();
  });
});
