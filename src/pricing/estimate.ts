import {
  displayModelName,
  findPricingModel,
  pricingCatalog,
  pricingCatalogVersion,
  type PricingModel
} from "./models.js";
import { priorityMultiplier, type PriorityTier } from "./priority.js";

export type CostStatus = "known" | "partial" | "unknown" | "disabled";

export type TokenUsageForEstimate = {
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
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

    const billableInputTokens = Math.max(0, usage.input_tokens - usage.cached_input_tokens);
    const cachedInputTokens = Math.max(0, Math.min(usage.cached_input_tokens, usage.input_tokens));
    const cachedInputRate = model.price.cachedInputUsdPerMillion ?? model.price.inputUsdPerMillion;
    const isLongContext = usage.long_context === true;
    if (usage.long_context === "unknown") longContextUnknown = true;
    const inputMultiplier = isLongContext ? (model.price.longContextInputMultiplier ?? 1) : 1;
    const outputMultiplier = isLongContext ? (model.price.longContextOutputMultiplier ?? 1) : 1;
    const priority = priorityMultiplier(usage.priority_tier ?? "base");
    estimatedCost +=
      ((billableInputTokens / million) * model.price.inputUsdPerMillion * inputMultiplier +
        (cachedInputTokens / million) * cachedInputRate * inputMultiplier +
        (usage.output_tokens / million) * model.price.outputUsdPerMillion * outputMultiplier) *
        priority;
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
