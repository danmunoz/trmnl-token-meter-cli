import type { ModelPrice, PricingModel } from "../models.js";

// OpenAI long context: above 272K input tokens the whole request reprices at 2x
// input/cached/cache-write and the published long-context output rate.
const longContext = (
  input: number,
  cached: number | null,
  write: number | null,
  output: number,
  longOutput: number
): ModelPrice => ({
  inputUsdPerMillion: input,
  cachedInputUsdPerMillion: cached,
  cacheCreationUsdPerMillion: write,
  outputUsdPerMillion: output,
  thresholdTokens: 272_000,
  thresholdMode: "full-row",
  inputUsdPerMillionAboveThreshold: input * 2,
  ...(cached === null ? {} : { cachedInputUsdPerMillionAboveThreshold: cached * 2 }),
  ...(write === null ? {} : { cacheCreationUsdPerMillionAboveThreshold: write * 2 }),
  outputUsdPerMillionAboveThreshold: longOutput
});

// API Fast tier at a flat multiple of standard rates. Fast is unavailable above
// 272K input except where `priorityLongContextMultiplier` says otherwise.
const fast = (price: ModelPrice, multiplier: number, longContextToo = false): ModelPrice => ({
  ...price,
  priorityInputUsdPerMillion: price.inputUsdPerMillion * multiplier,
  priorityCachedInputUsdPerMillion:
    price.cachedInputUsdPerMillion === null ? null : price.cachedInputUsdPerMillion * multiplier,
  priorityOutputUsdPerMillion: price.outputUsdPerMillion * multiplier,
  priorityInputTokenLimit: 272_000,
  ...(longContextToo ? { priorityLongContextMultiplier: multiplier } : {})
});

const gpt6Source = "models.dev openai (CodexBar 0.84.0 standard pricing source)";

export const openAIModels: PricingModel[] = [
  // GPT-6 family. Astra and 6.1 Sol publish Fast rates (2x) for long-context
  // requests too; 6 Sol, 6 Luna, and 6.1 Terra have no Fast tier in CodexBar.
  {
    id: "gpt-6-astra",
    aliases: ["gpt-6-astra"],
    effectiveDate: "2026-11-11",
    source: gpt6Source,
    price: fast(longContext(10, 1, 12.5, 50, 75), 2, true)
  },
  {
    // 6.1 Sol reads cache at $0.10/M, half of 6 Sol's $0.20/M.
    id: "gpt-6.1-sol",
    aliases: ["gpt-6.1-sol"],
    effectiveDate: "2026-11-11",
    source: gpt6Source,
    price: fast(longContext(2, 0.1, 2.5, 10, 15), 2, true)
  },
  {
    id: "gpt-6.1-terra",
    aliases: ["gpt-6.1-terra"],
    effectiveDate: "2026-11-11",
    source: gpt6Source,
    price: longContext(1, 0.05, 1.25, 5, 7.5)
  },
  {
    id: "gpt-6-sol",
    aliases: ["gpt-6-sol"],
    effectiveDate: "2026-11-11",
    source: gpt6Source,
    price: longContext(2, 0.2, 2.5, 10, 15)
  },
  {
    id: "gpt-6-luna",
    aliases: ["gpt-6-luna"],
    effectiveDate: "2026-11-11",
    source: gpt6Source,
    price: longContext(0.1, 0.01, 0.125, 0.5, 0.75)
  },
  {
    // Daybreak Cyber: no long-context tier is published; 5.5 Cyber lists no
    // cache-write rate. OpenAI's `gpt-daybreak-red-latest` alias points here.
    id: "gpt-5.6-cyber",
    aliases: ["gpt-5.6-cyber", "gpt-daybreak-red-latest"],
    effectiveDate: "2026-11-11",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 12.5,
      cachedInputUsdPerMillion: 1.25,
      cacheCreationUsdPerMillion: 15.625,
      outputUsdPerMillion: 75
    }
  },
  {
    id: "gpt-5.5-cyber",
    aliases: ["gpt-5.5-cyber"],
    effectiveDate: "2026-11-11",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 12.5,
      cachedInputUsdPerMillion: 1.25,
      outputUsdPerMillion: 75
    }
  },
  {
    // GPT-5.6 Sol/Terra/Luna. Full-row long-context: >272K input tokens reprices
    // the whole request. cacheCreation mirrors CodexBar's cache-write rate (1.25x
    // input); Codex rows in this collector never carry a separate cache-write lane,
    // so it stays as documented parity data. Priority is OpenAI's API Fast tier,
    // which CodexBar prices as a flat 2x multiplier on the standard rates for all
    // three tiers — keep the priority rates at exactly 2x their base.
    //
    // These rates were verified against CodexBar 0.56.3's own output on real usage:
    // solving three single-model days recovers Sol at 4/0.4/20 and Terra at
    // 2/0.2/12 to the cent. CodexBar resolves standard pricing from models.dev
    // before its bundled table, so models.dev is the authority here even where
    // CodexBar's vendored fallback still carries older numbers.
    id: "gpt-5.6-sol",
    aliases: ["gpt-5.6-sol", "gpt-5.6", "gpt-daybreak-blue-latest"],
    effectiveDate: "2026-07-30",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 4,
      cachedInputUsdPerMillion: 0.4,
      cacheCreationUsdPerMillion: 5,
      outputUsdPerMillion: 20,
      thresholdTokens: 272_000,
      thresholdMode: "full-row",
      inputUsdPerMillionAboveThreshold: 8,
      cachedInputUsdPerMillionAboveThreshold: 0.8,
      cacheCreationUsdPerMillionAboveThreshold: 10,
      outputUsdPerMillionAboveThreshold: 30,
      priorityInputUsdPerMillion: 8,
      priorityCachedInputUsdPerMillion: 0.8,
      priorityOutputUsdPerMillion: 40,
      priorityInputTokenLimit: 272_000
    }
  },
  {
    id: "gpt-5.6-terra",
    aliases: ["gpt-5.6-terra"],
    effectiveDate: "2026-07-30",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.2,
      cacheCreationUsdPerMillion: 2.5,
      outputUsdPerMillion: 12,
      thresholdTokens: 272_000,
      thresholdMode: "full-row",
      inputUsdPerMillionAboveThreshold: 4,
      cachedInputUsdPerMillionAboveThreshold: 0.4,
      cacheCreationUsdPerMillionAboveThreshold: 5,
      outputUsdPerMillionAboveThreshold: 18,
      priorityInputUsdPerMillion: 4,
      priorityCachedInputUsdPerMillion: 0.4,
      priorityOutputUsdPerMillion: 24,
      priorityInputTokenLimit: 272_000
    }
  },
  {
    id: "gpt-5.6-luna",
    // Codex reports the Luna Reserve quota bucket as `gpt-reserve`.
    aliases: ["gpt-5.6-luna", "gpt-reserve"],
    effectiveDate: "2026-07-30",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 0.2,
      cachedInputUsdPerMillion: 0.02,
      cacheCreationUsdPerMillion: 0.25,
      outputUsdPerMillion: 1.2,
      thresholdTokens: 272_000,
      thresholdMode: "full-row",
      inputUsdPerMillionAboveThreshold: 0.4,
      cachedInputUsdPerMillionAboveThreshold: 0.04,
      cacheCreationUsdPerMillionAboveThreshold: 0.5,
      outputUsdPerMillionAboveThreshold: 1.8,
      priorityInputUsdPerMillion: 0.4,
      priorityCachedInputUsdPerMillion: 0.04,
      priorityOutputUsdPerMillion: 2.4,
      priorityInputTokenLimit: 272_000
    }
  },
  {
    id: "gpt-5.5",
    aliases: ["gpt-5.5", "gpt-5.5-2026-04-23"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 30,
      thresholdTokens: 272_000,
      thresholdMode: "full-row",
      inputUsdPerMillionAboveThreshold: 10,
      cachedInputUsdPerMillionAboveThreshold: 1,
      outputUsdPerMillionAboveThreshold: 45,
      priorityInputUsdPerMillion: 12.5,
      priorityCachedInputUsdPerMillion: 1.25,
      priorityOutputUsdPerMillion: 75,
      priorityInputTokenLimit: 272_000
    }
  },
  {
    id: "gpt-5.5-pro",
    aliases: ["gpt-5.5-pro", "gpt-5.5-pro-2026-04-23"],
    effectiveDate: "2026-11-11",
    source: "CodexBar CostUsagePricing",
    price: longContext(30, null, null, 180, 270)
  },
  {
    id: "gpt-5.4",
    aliases: ["gpt-5.4"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
      thresholdTokens: 272_000,
      thresholdMode: "full-row",
      inputUsdPerMillionAboveThreshold: 5,
      cachedInputUsdPerMillionAboveThreshold: 0.5,
      outputUsdPerMillionAboveThreshold: 22.5,
      priorityInputUsdPerMillion: 5,
      priorityCachedInputUsdPerMillion: 0.5,
      priorityOutputUsdPerMillion: 30,
      priorityInputTokenLimit: 272_000
    }
  },
  {
    id: "gpt-5.4-mini",
    aliases: ["gpt-5.4-mini", "gpt-5.4 mini", "gpt-5.4-mini-2026-03-17"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 0.75,
      cachedInputUsdPerMillion: 0.075,
      outputUsdPerMillion: 4.5,
      priorityInputUsdPerMillion: 1.5,
      priorityCachedInputUsdPerMillion: 0.15,
      priorityOutputUsdPerMillion: 9,
      priorityInputTokenLimit: 272_000
    }
  },
  {
    id: "gpt-5.4-nano",
    aliases: ["gpt-5.4-nano", "gpt-5.4 nano", "gpt-5.4-nano-2026-03-17"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 0.2,
      cachedInputUsdPerMillion: 0.02,
      outputUsdPerMillion: 1.25
    }
  },
  {
    id: "gpt-5.4-pro",
    aliases: ["gpt-5.4-pro", "gpt-5.4 pro", "gpt-5.4-pro-2026-03-05"],
    effectiveDate: "2026-11-11",
    source: "CodexBar CostUsagePricing",
    price: longContext(30, null, null, 180, 270)
  },
  {
    id: "gpt-5.3-codex",
    aliases: ["gpt-5.3-codex", "gpt-5.3-codex-2026-03-05"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 1.75,
      cachedInputUsdPerMillion: 0.175,
      outputUsdPerMillion: 14
    }
  },
  {
    id: "gpt-5.3-codex-spark",
    aliases: ["gpt-5.3-codex-spark"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 0,
      cachedInputUsdPerMillion: 0,
      outputUsdPerMillion: 0
    }
  },
  {
    id: "gpt-5.2",
    aliases: ["gpt-5.2"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 1.75,
      cachedInputUsdPerMillion: 0.175,
      outputUsdPerMillion: 14
    }
  },
  {
    id: "gpt-5.2-codex",
    aliases: ["gpt-5.2-codex"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 1.75,
      cachedInputUsdPerMillion: 0.175,
      outputUsdPerMillion: 14
    }
  },
  {
    id: "gpt-5.2-pro",
    aliases: ["gpt-5.2-pro"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 21,
      cachedInputUsdPerMillion: null,
      outputUsdPerMillion: 168
    }
  },
  {
    id: "gpt-5.1",
    aliases: ["gpt-5.1"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 1.25,
      cachedInputUsdPerMillion: 0.125,
      outputUsdPerMillion: 10
    }
  },
  {
    id: "gpt-5.1-codex",
    aliases: ["gpt-5.1-codex"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 1.25,
      cachedInputUsdPerMillion: 0.125,
      outputUsdPerMillion: 10
    }
  },
  {
    id: "gpt-5.1-codex-max",
    aliases: ["gpt-5.1-codex-max"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 1.25,
      cachedInputUsdPerMillion: 0.125,
      outputUsdPerMillion: 10
    }
  },
  {
    id: "gpt-5.1-codex-mini",
    aliases: ["gpt-5.1-codex-mini"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 0.25,
      cachedInputUsdPerMillion: 0.025,
      outputUsdPerMillion: 2
    }
  },
  {
    id: "gpt-5",
    aliases: ["gpt-5", "gpt-5-2025-08-07"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 1.25,
      cachedInputUsdPerMillion: 0.125,
      outputUsdPerMillion: 10
    }
  },
  {
    id: "gpt-5-codex",
    aliases: ["gpt-5-codex"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 1.25,
      cachedInputUsdPerMillion: 0.125,
      outputUsdPerMillion: 10
    }
  },
  {
    id: "gpt-5-mini",
    aliases: ["gpt-5-mini", "gpt-5 mini"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 0.25,
      cachedInputUsdPerMillion: 0.025,
      outputUsdPerMillion: 2
    }
  },
  {
    id: "gpt-5-nano",
    aliases: ["gpt-5-nano", "gpt-5 nano"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 0.05,
      cachedInputUsdPerMillion: 0.005,
      outputUsdPerMillion: 0.4
    }
  },
  {
    id: "gpt-5-pro",
    aliases: ["gpt-5-pro", "gpt-5 pro"],
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 15,
      cachedInputUsdPerMillion: null,
      outputUsdPerMillion: 120
    }
  }
];
