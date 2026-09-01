import { describe, expect, it } from "vitest";
import { applyForkLedger } from "../src/forks.js";
import type { TokenUsage, UsageEvent } from "../src/types.js";

const event = (
  minute: number,
  last: TokenUsage,
  cumulative?: TokenUsage
): UsageEvent => ({
  ...last,
  ...(cumulative ? { cumulative_usage: cumulative } : {}),
  timestamp: new Date(`2026-05-15T08:${String(minute).padStart(2, "0")}:00.000Z`),
  model: "gpt-5",
  session_id: "session",
  record_kind: "delta"
});

const total = (events: readonly UsageEvent[]): number =>
  events.reduce((sum, item) => sum + item.input_tokens + item.output_tokens, 0);

describe("Codex cumulative counter ledger", () => {
  it("keeps per-turn usage after counted and raw cumulative totals diverge", () => {
    const result = applyForkLedger([
      event(
        1,
        { input_tokens: 80, cached_input_tokens: 60, output_tokens: 8 },
        { input_tokens: 100, cached_input_tokens: 70, output_tokens: 10 }
      ),
      event(
        2,
        { input_tokens: 30, cached_input_tokens: 20, output_tokens: 3 },
        { input_tokens: 110, cached_input_tokens: 75, output_tokens: 11 }
      )
    ]);

    expect(result.events.map((item) => item.input_tokens + item.output_tokens)).toEqual([88, 33]);
    expect(total(result.events)).toBe(121);
  });

  it("contains interleaved lineage regressions without replaying their gap", () => {
    const result = applyForkLedger([
      event(
        1,
        { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
        { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }
      ),
      event(
        2,
        { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5 },
        { input_tokens: 150, cached_input_tokens: 120, output_tokens: 15 }
      ),
      event(
        3,
        { input_tokens: 10, cached_input_tokens: 8, output_tokens: 1 },
        { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5 }
      ),
      event(
        4,
        { input_tokens: 20, cached_input_tokens: 16, output_tokens: 2 },
        { input_tokens: 160, cached_input_tokens: 128, output_tokens: 16 }
      ),
      event(
        5,
        { input_tokens: 50, cached_input_tokens: 40, output_tokens: 5 },
        { input_tokens: 150, cached_input_tokens: 120, output_tokens: 15 }
      )
    ]);

    expect(result.events.map((item) => item.input_tokens + item.output_tokens)).toEqual([
      110,
      55,
      0,
      11
    ]);
    expect(total(result.events)).toBe(176);
  });

  it("emits deltas that are safe to pass through the ledger again", () => {
    const once = applyForkLedger([
      event(
        1,
        { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
        { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }
      ),
      event(
        2,
        { input_tokens: 20, cached_input_tokens: 10, output_tokens: 2 },
        { input_tokens: 120, cached_input_tokens: 90, output_tokens: 12 }
      )
    ]).events;
    const twice = applyForkLedger(once).events;

    expect(twice).toEqual(once);
  });
});
