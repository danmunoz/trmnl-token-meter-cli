import type { PricingModel } from "../models.js";

const flat = (
  id: string,
  effectiveDate: string,
  source: string,
  input: number,
  cached: number,
  write: number,
  output: number
): PricingModel => ({
  id,
  aliases: [id],
  effectiveDate,
  source,
  price: {
    inputUsdPerMillion: input,
    cachedInputUsdPerMillion: cached,
    cacheCreationUsdPerMillion: write,
    outputUsdPerMillion: output
  }
});

const modelsDevSource = "models.dev anthropic (CodexBar 0.84.0 standard pricing source)";

export const anthropicModels: PricingModel[] = [
  // Claude 5.5 tier and Fable 5.2 come from models.dev, which CodexBar resolves
  // before its bundled table. Haiku 5.5 lists a context tier on models.dev but no
  // `context_over_200k` lane, so CodexBar (and this catalog) price it flat.
  flat("claude-opus-5-5", "2026-11-11", modelsDevSource, 4, 0.2, 5, 20),
  flat("claude-sonnet-5-5", "2026-11-11", modelsDevSource, 2, 0.1, 2.5, 10),
  flat("claude-haiku-5-5", "2026-11-11", modelsDevSource, 0.1, 0.01, 0.125, 0.5),
  flat("claude-fable-5-2", "2026-11-11", modelsDevSource, 8, 0.2, 10, 40),
  // Mythos is served to verified organizations only and is absent from models.dev,
  // so CodexBar's bundled table is the source.
  flat("claude-mythos-5-1", "2026-11-11", "CodexBar CostUsagePricing", 10, 0.25, 12.5, 50),
  flat("claude-mythos-5", "2026-11-11", "CodexBar CostUsagePricing", 10, 1, 12.5, 50),
  {
    // Fable 5.1 shares Fable 5's input and output rates but reads cache far more
    // cheaply: $0.25/M against Fable 5's $1/M.
    id: "claude-fable-5-1",
    aliases: ["claude-fable-5-1"],
    effectiveDate: "2026-09-03",
    source: "models.dev anthropic (CodexBar 0.56.3+ standard pricing source)",
    price: {
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: 0.25,
      cacheCreationUsdPerMillion: 12.5,
      outputUsdPerMillion: 50
    }
  },
  {
    id: "claude-fable-5",
    aliases: ["claude-fable-5"],
    effectiveDate: "2026-07-12",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: 1,
      cacheCreationUsdPerMillion: 12.5,
      outputUsdPerMillion: 50
    }
  },
  {
    id: "claude-opus-5",
    aliases: ["claude-opus-5"],
    effectiveDate: "2026-09-03",
    source: "models.dev anthropic (CodexBar 0.56.3+ standard pricing source)",
    price: {
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      cacheCreationUsdPerMillion: 6.25,
      outputUsdPerMillion: 25
    }
  },
  {
    id: "claude-sonnet-5",
    aliases: ["claude-sonnet-5"],
    effectiveDate: "2026-09-03",
    source: "models.dev anthropic (CodexBar 0.56.3+ standard pricing source)",
    price: {
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.2,
      cacheCreationUsdPerMillion: 2.5,
      outputUsdPerMillion: 10
    }
  },
  {
    id: "claude-haiku-4-5",
    aliases: ["claude-haiku-4-5", "claude-haiku-4-5-20251001"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 1,
      cachedInputUsdPerMillion: 0.1,
      cacheCreationUsdPerMillion: 1.25,
      outputUsdPerMillion: 5
    }
  },
  {
    id: "claude-opus-4-5",
    aliases: ["claude-opus-4-5", "claude-opus-4-5-20251101"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      cacheCreationUsdPerMillion: 6.25,
      outputUsdPerMillion: 25
    }
  },
  {
    id: "claude-opus-4-6",
    aliases: ["claude-opus-4-6", "claude-opus-4-6-20260205"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      cacheCreationUsdPerMillion: 6.25,
      outputUsdPerMillion: 25
    }
  },
  {
    id: "claude-opus-4-7",
    aliases: ["claude-opus-4-7"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      cacheCreationUsdPerMillion: 6.25,
      outputUsdPerMillion: 25
    }
  },
  {
    id: "claude-opus-4-8",
    aliases: ["claude-opus-4-8"],
    effectiveDate: "2026-06-02",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      cacheCreationUsdPerMillion: 6.25,
      outputUsdPerMillion: 25
    }
  },
  {
    // Claude long context is all-or-nothing on the whole request, and it triggers on
    // the full prompt — input plus both cache lanes — rather than the input lane
    // alone. `full-row` plus the estimator's prompt-size check matches CodexBar.
    id: "claude-sonnet-4-5",
    aliases: ["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 3,
      cachedInputUsdPerMillion: 0.3,
      cacheCreationUsdPerMillion: 3.75,
      outputUsdPerMillion: 15,
      thresholdTokens: 200_000,
      thresholdMode: "full-row",
      inputUsdPerMillionAboveThreshold: 6,
      cachedInputUsdPerMillionAboveThreshold: 0.6,
      cacheCreationUsdPerMillionAboveThreshold: 7.5,
      outputUsdPerMillionAboveThreshold: 22.5
    }
  },
  {
    // CodexBar #1372 repriced Sonnet 4.6 to flat standard pricing; the tiered
    // long-context rates now apply only to records before the March 2026 cutoff,
    // which this collector never reports (last 30 days only).
    id: "claude-sonnet-4-6",
    aliases: ["claude-sonnet-4-6"],
    effectiveDate: "2026-07-12",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 3,
      cachedInputUsdPerMillion: 0.3,
      cacheCreationUsdPerMillion: 3.75,
      outputUsdPerMillion: 15
    }
  },
  {
    id: "claude-opus-4-20250514",
    aliases: ["claude-opus-4-20250514"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 15,
      cachedInputUsdPerMillion: 1.5,
      cacheCreationUsdPerMillion: 18.75,
      outputUsdPerMillion: 75
    }
  },
  {
    id: "claude-opus-4-1",
    aliases: ["claude-opus-4-1"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 15,
      cachedInputUsdPerMillion: 1.5,
      cacheCreationUsdPerMillion: 18.75,
      outputUsdPerMillion: 75
    }
  },
  {
    id: "claude-sonnet-4-20250514",
    aliases: ["claude-sonnet-4-20250514"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 3,
      cachedInputUsdPerMillion: 0.3,
      cacheCreationUsdPerMillion: 3.75,
      outputUsdPerMillion: 15,
      thresholdTokens: 200_000,
      thresholdMode: "full-row",
      inputUsdPerMillionAboveThreshold: 6,
      cachedInputUsdPerMillionAboveThreshold: 0.6,
      cacheCreationUsdPerMillionAboveThreshold: 7.5,
      outputUsdPerMillionAboveThreshold: 22.5
    }
  }
];
