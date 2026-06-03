import {
  displayModelName,
  findPricingModel,
  pricingCatalog,
  pricingCatalogVersion,
  type PricingModel
} from "./models.js";
import type { PriorityTier } from "./priority.js";

export type CostStatus = "known" | "partial" | "unknown" | "disabled";

export type TokenUsageForEstimate = {
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  long_context?: boolean | "unknown";
  priority_tier?: PriorityTier;
};

export type CostEstimate = {
  estimated_cost_usd: number | null;
  cost_status: CostStatus;
  pricing_catalog_version: string;
  effective_date: string | null;
  unknown_models: string[];
  long_context_unknown: boolean;
};

const million = 1_000_000;

const roundUsd = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

const positiveTokens = (value: number | undefined): number => Math.max(0, Math.floor(value ?? 0));

const priceTokens = (
  tokens: number,
  baseUsdPerMillion: number,
  aboveThresholdUsdPerMillion: number | undefined,
  thresholdTokens: number | undefined,
  thresholdMode: "tiered" | "full-row" | undefined
): number => {
  if (thresholdTokens === undefined || aboveThresholdUsdPerMillion === undefined) {
    return (tokens / million) * baseUsdPerMillion;
  }

  if (thresholdMode === "full-row") {
    return (tokens / million) * aboveThresholdUsdPerMillion;
  }

  const below = Math.min(tokens, thresholdTokens);
  const above = Math.max(0, tokens - thresholdTokens);
  return (
    (below / million) * baseUsdPerMillion + (above / million) * aboveThresholdUsdPerMillion
  );
};

export const estimateUsageCost = (
  usages: readonly TokenUsageForEstimate[],
  options: { showCost?: boolean; catalog?: readonly PricingModel[] } = {}
): CostEstimate => {
  if (options.showCost === false) {
    return {
      estimated_cost_usd: null,
      cost_status: "disabled",
      pricing_catalog_version: pricingCatalogVersion,
      effective_date: null,
      unknown_models: [],
      long_context_unknown: false
    };
  }

  if (usages.length === 0) {
    return {
      estimated_cost_usd: 0,
      cost_status: "known",
      pricing_catalog_version: pricingCatalogVersion,
      effective_date: null,
      unknown_models: [],
      long_context_unknown: false
    };
  }

  const catalog = options.catalog ?? pricingCatalog;
  const unknownModels = new Set<string>();
  const effectiveDates = new Set<string>();
  let estimatedCost = 0;
  let knownRows = 0;
  let longContextUnknown = false;

  for (const usage of usages) {
    const model = findPricingModel(usage.model, catalog);
    if (!model) {
      unknownModels.add(usage.model || "unknown");
      continue;
    }

    const hasExplicitCacheLanes =
      usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
    const rawInputTokens = positiveTokens(usage.input_tokens);
    const inputTokens = hasExplicitCacheLanes
      ? rawInputTokens
      : Math.max(0, usage.input_tokens - usage.cached_input_tokens);
    const cachedInputTokens = hasExplicitCacheLanes
      ? positiveTokens(usage.cache_read_input_tokens)
      : Math.max(0, Math.min(usage.cached_input_tokens, usage.input_tokens));
    const cacheCreationTokens = positiveTokens(usage.cache_creation_input_tokens);
    const outputTokens = positiveTokens(usage.output_tokens);
    const thresholdMode = model.price.thresholdMode ?? "tiered";
    const useFullRowThreshold =
      thresholdMode === "full-row" &&
      model.price.thresholdTokens !== undefined &&
      rawInputTokens > model.price.thresholdTokens;
    const priorityLimit = model.price.priorityInputTokenLimit;
    const priorityInputRate = model.price.priorityInputUsdPerMillion;
    const priorityOutputRate = model.price.priorityOutputUsdPerMillion;
    const usePriorityRates =
      usage.priority_tier === "priority" &&
      priorityInputRate !== undefined &&
      priorityOutputRate !== undefined &&
      (priorityLimit === undefined || rawInputTokens <= priorityLimit);
    const inputRate = usePriorityRates
      ? (priorityInputRate ?? model.price.inputUsdPerMillion)
      : useFullRowThreshold
        ? (model.price.inputUsdPerMillionAboveThreshold ?? model.price.inputUsdPerMillion)
        : model.price.inputUsdPerMillion;
    const cachedInputRate = usePriorityRates
      ? (model.price.priorityCachedInputUsdPerMillion ??
        priorityInputRate ??
        model.price.inputUsdPerMillion)
      : useFullRowThreshold
        ? (model.price.cachedInputUsdPerMillionAboveThreshold ??
          model.price.cachedInputUsdPerMillion ??
          model.price.inputUsdPerMillion)
        : (model.price.cachedInputUsdPerMillion ?? model.price.inputUsdPerMillion);
    const cacheCreationRate = useFullRowThreshold
      ? (model.price.cacheCreationUsdPerMillionAboveThreshold ??
        model.price.cacheCreationUsdPerMillion ??
        inputRate)
      : (model.price.cacheCreationUsdPerMillion ?? inputRate);
    const outputRate = usePriorityRates
      ? (priorityOutputRate ?? model.price.outputUsdPerMillion)
      : useFullRowThreshold
        ? (model.price.outputUsdPerMillionAboveThreshold ?? model.price.outputUsdPerMillion)
        : model.price.outputUsdPerMillion;
    if (usage.long_context === "unknown") longContextUnknown = true;
    estimatedCost +=
      priceTokens(
        inputTokens,
        inputRate,
        usePriorityRates || useFullRowThreshold || thresholdMode === "full-row"
          ? undefined
          : model.price.inputUsdPerMillionAboveThreshold,
        model.price.thresholdTokens,
        thresholdMode
      ) +
      priceTokens(
        cachedInputTokens,
        cachedInputRate,
        usePriorityRates || useFullRowThreshold || thresholdMode === "full-row"
          ? undefined
          : model.price.cachedInputUsdPerMillionAboveThreshold,
        model.price.thresholdTokens,
        thresholdMode
      ) +
      priceTokens(
        cacheCreationTokens,
        cacheCreationRate,
        usePriorityRates || useFullRowThreshold || thresholdMode === "full-row"
          ? undefined
          : model.price.cacheCreationUsdPerMillionAboveThreshold,
        model.price.thresholdTokens,
        thresholdMode
      ) +
      priceTokens(
        outputTokens,
        outputRate,
        usePriorityRates || useFullRowThreshold || thresholdMode === "full-row"
          ? undefined
          : model.price.outputUsdPerMillionAboveThreshold,
        model.price.thresholdTokens,
        thresholdMode
      );
    knownRows += 1;
    effectiveDates.add(model.effectiveDate);
  }

  const costStatus: CostStatus =
    knownRows === 0
      ? "unknown"
      : unknownModels.size > 0 || knownRows < usages.length || longContextUnknown
        ? "partial"
        : "known";

  return {
    estimated_cost_usd: knownRows === 0 ? null : roundUsd(estimatedCost),
    cost_status: costStatus,
    pricing_catalog_version: pricingCatalogVersion,
    effective_date: effectiveDates.size === 1 ? ([...effectiveDates][0] ?? null) : null,
    unknown_models: [...unknownModels].sort(),
    long_context_unknown: longContextUnknown
  };
};

export const normalizeEstimateModelName = displayModelName;
