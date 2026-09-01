import { pricingCatalogVersion } from "./models.js";

// CodexBar parity port notes:
// This module captures behavior translated for TRMNL Token Meter's local-only
// aggregate cost calculation. CodexBar is MIT licensed; keep this attribution
// with any code substantially copied from a reviewed CodexBar source revision.
// Attribution: CodexBar, MIT license.
// Pricing source reference: https://github.com/steipete/CodexBar/blob/5351013a211f90df83b91d7ec2b788ff1c35c1f3/Sources/CodexBarCore/Vendored/CostUsage/CostUsagePricing.swift

export const codexBarPricingCatalogVersion = pricingCatalogVersion;

export const roundUsd = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;
