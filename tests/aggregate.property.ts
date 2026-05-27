import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { SUPPORTED_PROVIDERS } from "../src/source-providers.js";
import type { UsageEvent } from "../src/types.js";

describe("aggregation properties", () => {
  it("keeps deltas non-negative and clamps cached input", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const events: UsageEvent[] = Array.from({ length: 50 }, (_, index) => {
        const input = (seed * 97 + index * 31) % 10_000;
        const cached = (seed * 193 + index * 67) % 20_000;
        const output = (seed * 389 + index * 43) % 10_000;
        return {
          timestamp: new Date(`2026-05-${String((index % 15) + 1).padStart(2, "0")}T12:00:00.000Z`),
          model: "gpt-5",
          session_id: `s-${seed}-${index}`,
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          record_kind: "delta"
        };
      });
      const snapshot = buildAggregate(events, {
        machineId: "mach",
        machineLabel: "Machine",
        codexHomeKind: "default",
        now: new Date("2026-05-15T12:00:00.000Z")
      });

      for (const day of snapshot.daily) {
        expect(day.total_tokens).toBeGreaterThanOrEqual(0);
        expect(JSON.stringify(day)).not.toContain("input_tokens");
        expect(JSON.stringify(day)).not.toContain("cached_input_tokens");
        expect(JSON.stringify(day)).not.toContain("output_tokens");
        expect(JSON.stringify(day)).not.toContain("token_breakdown");
      }
    }
  });

  it("keeps period totals stable when records are unchanged", () => {
    const events: UsageEvent[] = Array.from({ length: 10 }, (_, index) => ({
      timestamp: new Date(`2026-05-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`),
      model: "gpt-5",
      session_id: `stable-${index}`,
      input_tokens: 100 + index,
      cached_input_tokens: 10,
      output_tokens: 50 + index,
      record_kind: "delta"
    }));

    const options = {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "default" as const,
      now: new Date("2026-05-15T12:00:00.000Z")
    };
    const first = buildAggregate(events, options);
    const second = buildAggregate(events, options);

    expect(second.periods).toEqual(first.periods);
    expect(second.daily).toEqual(first.daily);
    expect(second.models).toEqual(first.models);
  });

  it("includes provider consent metadata in aggregate snapshots", () => {
    const snapshot = buildAggregate([], {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "default",
      now: new Date("2026-05-15T12:00:00.000Z")
    });
    expect(snapshot.collector.supported_providers).toEqual(SUPPORTED_PROVIDERS);
    expect(snapshot.collector.enabled_providers).toEqual(["codex"]);
    expect(snapshot.collector.provider_statuses).toEqual([]);
  });
});
