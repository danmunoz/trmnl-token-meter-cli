import { describe, expect, it } from "vitest";
import { estimateUsageCost, findPricingModel, roundUsd } from "../../src/pricing/index.js";

const codexCost = (
  model: string,
  input: number,
  cached: number,
  output: number,
  priority: "base" | "priority" = "base"
) =>
  estimateUsageCost([
    { model, input_tokens: input, cached_input_tokens: cached, output_tokens: output, priority_tier: priority }
  ]).estimated_cost_usd;

const claudeCost = (model: string, input: number, read: number, write: number, output: number) =>
  estimateUsageCost([
    {
      model,
      input_tokens: input,
      cached_input_tokens: read,
      output_tokens: output,
      cache_read_input_tokens: read,
      cache_creation_input_tokens: write
    }
  ]).estimated_cost_usd;

describe("CodexBar 0.84.0 catalog parity", () => {
  it.each([
    // model, input, cached, output ($/M) — standard short-context rates
    ["gpt-6-astra", 10, 1, 50],
    ["gpt-6.1-sol", 2, 0.1, 10],
    ["gpt-6.1-terra", 1, 0.05, 5],
    ["gpt-6-sol", 2, 0.2, 10],
    ["gpt-6-luna", 0.1, 0.01, 0.5],
    ["gpt-5.6-cyber", 12.5, 1.25, 75],
    ["gpt-5.5-cyber", 12.5, 1.25, 75]
  ])("prices %s at its standard rates", (model, input, cached, output) => {
    // 200K prompt (100K cached) stays under the 272K long-context threshold.
    expect(codexCost(model, 200_000, 100_000, 10_000)).toBe(
      roundUsd((100_000 * input + 100_000 * cached + 10_000 * output) / 1e6)
    );
  });

  it.each([
    ["claude-opus-5-5", 4, 0.2, 5, 20],
    ["claude-sonnet-5-5", 2, 0.1, 2.5, 10],
    ["claude-haiku-5-5", 0.1, 0.01, 0.125, 0.5],
    ["claude-fable-5-2", 8, 0.2, 10, 40],
    ["claude-mythos-5-1", 10, 0.25, 12.5, 50],
    ["claude-mythos-5", 10, 1, 12.5, 50]
  ])("prices %s with separate Claude cache lanes", (model, input, read, write, output) => {
    expect(claudeCost(model, 1_000, 200_000, 50_000, 5_000)).toBe(
      roundUsd((1_000 * input + 200_000 * read + 50_000 * write + 5_000 * output) / 1e6)
    );
  });

  it("prices Haiku 5.5 flat even past 100K, like CodexBar", () => {
    expect(claudeCost("claude-haiku-5-5", 150_000, 0, 0, 0)).toBe(roundUsd(150_000 * 0.1e-6));
  });

  it("prices DeepSeek usage recorded by Claude Code, billing cache writes at input", () => {
    expect(claudeCost("deepseek-v4-pro", 10_000, 100_000, 20_000, 3_000)).toBe(
      roundUsd((10_000 * 0.66 + 100_000 * 0.022 + 20_000 * 0.66 + 3_000 * 1.98) / 1e6)
    );
    expect(findPricingModel("deepseek-flash")?.id).toBe("deepseek-flash");
  });

  it("resolves Codex aliases CodexBar maps onto existing models", () => {
    expect(findPricingModel("gpt-reserve")?.id).toBe("gpt-5.6-luna");
    expect(findPricingModel("gpt-daybreak-blue-latest")?.id).toBe("gpt-5.6-sol");
    expect(findPricingModel("gpt-daybreak-red-latest")?.id).toBe("gpt-5.6-cyber");
  });

  it("reprices the whole GPT-6 request above 272K input", () => {
    expect(codexCost("gpt-6-astra", 300_000, 100_000, 10_000)).toBe(
      roundUsd((200_000 * 20 + 100_000 * 2 + 10_000 * 75) / 1e6)
    );
  });

  it("prices Astra and GPT-6.1 Sol Fast at 2x, including long context", () => {
    expect(codexCost("gpt-6.1-sol", 200_000, 100_000, 10_000, "priority")).toBe(
      roundUsd(2 * ((100_000 * 2 + 100_000 * 0.1 + 10_000 * 10) / 1e6))
    );
    expect(codexCost("gpt-6.1-sol", 300_000, 100_000, 10_000, "priority")).toBe(
      roundUsd(2 * ((200_000 * 4 + 100_000 * 0.2 + 10_000 * 15) / 1e6))
    );
    expect(codexCost("gpt-6-astra", 300_000, 0, 0, "priority")).toBe(roundUsd(2 * 300_000 * 20e-6));
  });

  it("keeps older models at standard long-context rates when Fast exceeds 272K", () => {
    expect(codexCost("gpt-5.6-sol", 300_000, 0, 0, "priority")).toBe(roundUsd(300_000 * 8e-6));
  });

  it("has no Fast tier for GPT-6 Sol, GPT-6 Luna, or GPT-6.1 Terra", () => {
    for (const model of ["gpt-6-sol", "gpt-6-luna", "gpt-6.1-terra"]) {
      expect(codexCost(model, 100_000, 0, 1_000, "priority")).toBe(codexCost(model, 100_000, 0, 1_000));
    }
  });

  it("applies long context to the Pro models and bills their cached reads at input", () => {
    expect(codexCost("gpt-5.5-pro", 300_000, 100_000, 10_000)).toBe(
      roundUsd((300_000 * 60 + 10_000 * 270) / 1e6)
    );
    expect(codexCost("gpt-5.4-pro", 100_000, 50_000, 1_000)).toBe(roundUsd((100_000 * 30 + 1_000 * 180) / 1e6));
  });
});
