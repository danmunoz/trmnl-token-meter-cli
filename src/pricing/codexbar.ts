import { pricingCatalog, pricingCatalogVersion } from "./models.js";

// CodexBar parity port notes:
// This module captures behavior translated for TRMNL Token Meter's local-only
// aggregate cost calculation. CodexBar is MIT licensed; keep this attribution
// with any code substantially copied from a reviewed CodexBar source revision.
export const codexBarAttribution = {
  project: "CodexBar",
  license: "MIT",
  sourceReference: "https://github.com/search?q=CodexBar+cost&type=repositories"
} as const;

export const codexBarPricingCatalogVersion = pricingCatalogVersion;
export const codexBarPricingCatalog = pricingCatalog;

export const roundUsd = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
