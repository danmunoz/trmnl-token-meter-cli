export type ModelPrice = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number | null;
  cacheCreationUsdPerMillion?: number | null;
  outputUsdPerMillion: number;
  thresholdTokens?: number;
  thresholdMode?: "tiered" | "full-row";
  inputUsdPerMillionAboveThreshold?: number;
  cachedInputUsdPerMillionAboveThreshold?: number;
  cacheCreationUsdPerMillionAboveThreshold?: number;
  outputUsdPerMillionAboveThreshold?: number;
  priorityInputUsdPerMillion?: number;
  priorityCachedInputUsdPerMillion?: number | null;
  priorityOutputUsdPerMillion?: number;
  priorityInputTokenLimit?: number;
};

export type PricingModel = {
  id: string;
  aliases: string[];
  effectiveDate: string;
  source: string;
  price: ModelPrice;
};

export const pricingCatalogVersion = "2026-09-03.codexbar-parity" as const;

export const pricingCatalog: PricingModel[] = [
  {
    // Fable 5.1 shares Fable 5's input and output rates but reads cache far more
    // cheaply: $0.25/M against Fable 5's $1/M.
    id: "claude-fable-5-1",
    aliases: ["claude-fable-5-1"],
    effectiveDate: "2026-09-03",
    source: "models.dev anthropic (CodexBar 0.56.3 standard pricing source)",
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
    source: "models.dev anthropic (CodexBar 0.56.3 standard pricing source)",
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
    source: "models.dev anthropic (CodexBar 0.56.3 standard pricing source)",
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
      inputUsdPerMillionAboveThreshold: 6,
      cachedInputUsdPerMillionAboveThreshold: 0.6,
      cacheCreationUsdPerMillionAboveThreshold: 7.5,
      outputUsdPerMillionAboveThreshold: 22.5
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
    aliases: ["gpt-5.6-sol", "gpt-5.6"],
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
    aliases: ["gpt-5.6-luna"],
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
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 30,
      cachedInputUsdPerMillion: null,
      outputUsdPerMillion: 180
    }
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
    effectiveDate: "2026-05-15",
    source: "CodexBar CostUsagePricing",
    price: {
      inputUsdPerMillion: 30,
      cachedInputUsdPerMillion: null,
      outputUsdPerMillion: 180
    }
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
] as const satisfies PricingModel[];

const normalizeBasicModelName = (modelName: string): string => {
  let normalized = modelName.trim().toLowerCase().replace(/\s+/g, "-");
  if (normalized.startsWith("openai/")) {
    normalized = normalized.slice("openai/".length);
  }
  if (normalized.startsWith("anthropic.")) {
    normalized = normalized.slice("anthropic.".length);
  }

  const lastDot = normalized.lastIndexOf(".");
  if (lastDot >= 0) {
    const tail = normalized.slice(lastDot + 1);
    if (tail.startsWith("claude-")) normalized = tail;
  }

  normalized = normalized.replace(/-v\d+:\d+$/, "");
  return normalized;
};

const normalizeModelName = (modelName: string): string => {
  const normalized = normalizeBasicModelName(modelName);

  const withoutCompactDate = normalized.replace(/-\d{8}$/, "");
  if (
    withoutCompactDate !== normalized &&
    pricingCatalog.some((model) =>
      model.aliases.some((alias) => normalizeBasicModelName(alias) === withoutCompactDate)
    )
  ) {
    return withoutCompactDate;
  }

  const withoutDashedDate = normalized.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (
    withoutDashedDate !== normalized &&
    pricingCatalog.some((model) =>
      model.aliases.some((alias) => normalizeBasicModelName(alias) === withoutDashedDate)
    )
  ) {
    return withoutDashedDate;
  }

  return normalized;
};

export const displayModelName = (modelName: string): string => {
  const model = findPricingModel(modelName);
  return model?.id ?? "unknown";
};

export const findPricingModel = (
  modelName: string,
  catalog: readonly PricingModel[] = pricingCatalog
): PricingModel | null => {
  const normalized = normalizeModelName(modelName);
  return (
    catalog.find((model) =>
      model.aliases.some((alias) => normalizeModelName(alias) === normalized)
    ) ?? null
  );
};
