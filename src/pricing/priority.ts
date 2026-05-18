export type PriorityTier = "base" | "priority" | "unknown";

export const priorityMultiplier = (tier: PriorityTier): number => (tier === "priority" ? 2 : 1);

export const priorityTokens = (tier: PriorityTier, inputTokens: number, outputTokens: number): number =>
  tier === "priority" ? Math.max(0, inputTokens) + Math.max(0, outputTokens) : 0;
