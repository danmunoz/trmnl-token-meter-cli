import { anthropicModels } from "./catalog/anthropic.js";
import { deepSeekModels } from "./catalog/deepseek.js";
import { openAIModels } from "./catalog/openai.js";

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
  /**
   * Set only for models whose Fast tier is also published for long-context
   * requests (GPT-6 Astra, GPT-6.1 Sol). A priority request above the threshold
   * then bills the full-row long-context rates times this multiplier instead of
   * falling back to standard long-context pricing.
   */
  priorityLongContextMultiplier?: number;
};

export type PricingModel = {
  id: string;
  aliases: string[];
  effectiveDate: string;
  source: string;
  price: ModelPrice;
};

export const pricingCatalogVersion = "2026-11-11.codexbar-parity" as const;

export const pricingCatalog: readonly PricingModel[] = [
  ...anthropicModels,
  ...openAIModels,
  ...deepSeekModels
];

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

// Basic-normalized aliases of the bundled catalog. Date suffixes are stripped only
// when the undated name is a known alias, so a dated snapshot of an unknown model
// stays distinct.
const knownBasicAliases = new Set(
  pricingCatalog.flatMap((model) => model.aliases.map(normalizeBasicModelName))
);

const normalizeModelName = (modelName: string): string => {
  const normalized = normalizeBasicModelName(modelName);

  const withoutCompactDate = normalized.replace(/-\d{8}$/, "");
  if (withoutCompactDate !== normalized && knownBasicAliases.has(withoutCompactDate)) {
    return withoutCompactDate;
  }

  const withoutDashedDate = normalized.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (withoutDashedDate !== normalized && knownBasicAliases.has(withoutDashedDate)) {
    return withoutDashedDate;
  }

  return normalized;
};

// Lookup runs once per usage row, so each catalog's aliases are normalized once
// and indexed. The first model listing an alias wins, matching catalog order.
const aliasIndexes = new WeakMap<readonly PricingModel[], Map<string, PricingModel>>();

const aliasIndex = (catalog: readonly PricingModel[]): Map<string, PricingModel> => {
  let index = aliasIndexes.get(catalog);
  if (!index) {
    index = new Map();
    for (const model of catalog) {
      for (const alias of model.aliases) {
        const key = normalizeModelName(alias);
        if (!index.has(key)) index.set(key, model);
      }
    }
    aliasIndexes.set(catalog, index);
  }
  return index;
};

export const displayModelName = (modelName: string): string => {
  const model = findPricingModel(modelName);
  return model?.id ?? "unknown";
};

export const findPricingModel = (
  modelName: string,
  catalog: readonly PricingModel[] = pricingCatalog
): PricingModel | null => aliasIndex(catalog).get(normalizeModelName(modelName)) ?? null;
