export type ModelPrice = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number;
  longContextInputMultiplier?: number;
  longContextOutputMultiplier?: number;
};

export type PricingModel = {
  id: string;
  aliases: string[];
  effectiveDate: string;
  source: string;
  price: ModelPrice;
};

export const pricingCatalogVersion = "2026-05-15.codexbar-parity" as const;

export const pricingCatalog: PricingModel[] = [
  {
    id: "gpt-5.5",
    aliases: ["gpt-5.5", "gpt-5.5-2026-04-23"],
    effectiveDate: "2026-05-15",
    source: "https://openai.com/api/pricing/",
    price: {
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 30,
      longContextInputMultiplier: 2,
      longContextOutputMultiplier: 1.5
    }
  },
  {
    id: "gpt-5.4",
    aliases: ["gpt-5.4", "gpt-5.4-codex"],
    effectiveDate: "2026-05-15",
    source: "https://openai.com/api/pricing/",
    price: {
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15
    }
  },
  {
    id: "gpt-5.3-codex",
    aliases: ["gpt-5.3-codex", "gpt-5.3 codex", "codex-5.3", "gpt-codex-5.3"],
    effectiveDate: "2026-05-15",
    source: "https://developers.openai.com/api/docs/models/gpt-5.3-codex",
    price: {
      inputUsdPerMillion: 1.75,
      cachedInputUsdPerMillion: 0.175,
      outputUsdPerMillion: 14
    }
  },
  {
    id: "gpt-5.4-mini",
    aliases: ["gpt-5.4-mini", "gpt-5.4 mini"],
    effectiveDate: "2026-05-15",
    source: "https://openai.com/api/pricing/",
    price: {
      inputUsdPerMillion: 0.75,
      cachedInputUsdPerMillion: 0.075,
      outputUsdPerMillion: 4.5
    }
  },
  {
    id: "gpt-5",
    aliases: ["gpt-5", "gpt-5-2025-08-07"],
    effectiveDate: "2026-05-15",
    source: "https://openai.com/api/pricing/",
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
    source: "https://openai.com/api/pricing/",
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
    source: "https://openai.com/api/pricing/",
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
    source: "https://openai.com/api/pricing/",
    price: {
      inputUsdPerMillion: 15,
      cachedInputUsdPerMillion: null,
      outputUsdPerMillion: 120
    }
  }
] as const satisfies PricingModel[];

const normalizeModelName = (modelName: string): string =>
  modelName.trim().toLowerCase().replace(/\s+/g, "-");

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
