import type { PricingModel } from "../models.js";

// CodexBar prices `deepseek-*` models recorded by Claude Code (Claude Code pointed
// at DeepSeek's Anthropic-compatible API) from the models.dev `deepseek` provider.
// DeepSeek publishes no cache-write rate, so cache writes bill at the input rate.
const deepSeek = (id: string, input: number, cached: number, output: number): PricingModel => ({
  id,
  aliases: [id],
  effectiveDate: "2026-11-11",
  source: "models.dev deepseek (CodexBar 0.84.0 standard pricing source)",
  price: {
    inputUsdPerMillion: input,
    cachedInputUsdPerMillion: cached,
    cacheCreationUsdPerMillion: null,
    outputUsdPerMillion: output
  }
});

export const deepSeekModels: PricingModel[] = [
  deepSeek("deepseek-v4-pro", 0.66, 0.022, 1.98),
  deepSeek("deepseek-v4-flash", 0.15, 0.003, 0.6),
  deepSeek("deepseek-flash", 0.15, 0.003, 0.6),
  deepSeek("deepseek-chat", 0.14, 0.0028, 0.28),
  deepSeek("deepseek-reasoner", 0.14, 0.0028, 0.28)
];
