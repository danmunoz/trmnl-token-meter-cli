import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import type { UsageEvent } from "../src/types.js";

const now = new Date("2026-05-15T12:00:00.000Z");

describe("model usage aggregation", () => {
  it("normalizes, groups, and ranks model totals", () => {
    const events: UsageEvent[] = [
      {
        timestamp: now,
        model: "GPT-5",
        session_id: "s1",
        input_tokens: 20,
        cached_input_tokens: 4,
        output_tokens: 10,
        record_kind: "delta"
      },
      {
        timestamp: now,
        model: "gpt-5",
        session_id: "s2",
        input_tokens: 40,
        cached_input_tokens: 5,
        output_tokens: 30,
        record_kind: "delta"
      },
      {
        timestamp: now,
        model: "",
        session_id: "s3",
        input_tokens: 5,
        cached_input_tokens: 0,
        output_tokens: 1,
        record_kind: "delta"
      }
    ];

    const snapshot = buildAggregate(events, {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "default",
      now
    });

    expect(snapshot.models.map((model) => model.name)).toEqual(["gpt-5", "unknown"]);
    expect(snapshot.models[0]?.total_tokens).toBe(100);
    expect(snapshot.models[1]?.total_tokens).toBe(6);
    expect(snapshot.collector.warnings.map((warning) => warning.code)).toContain("unknown_pricing");
  });
});
