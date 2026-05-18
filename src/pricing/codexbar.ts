import { pricingCatalogVersion } from "./models.js";

// CodexBar parity port notes:
// This module captures behavior translated for TRMNL Token Meter's local-only
// aggregate cost calculation. CodexBar is MIT licensed; keep this attribution
// with any code substantially copied from a reviewed CodexBar source revision.
// Attribution: CodexBar, MIT license.
// Source reference: https://github.com/search?q=CodexBar+cost&type=repositories

export const codexBarPricingCatalogVersion = pricingCatalogVersion;

export const roundUsd = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
