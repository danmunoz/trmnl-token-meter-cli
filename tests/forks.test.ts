import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { readJsonlUsageSource } from "../src/cost-sources/jsonl.js";

const fixtureRoot = new URL("./fixtures/codex-jsonl/custom", import.meta.url).pathname;

describe("fork-aware aggregation", () => {
  it("deduplicates cumulative counters per branch and emits ambiguity warnings", async () => {
    const result = await readJsonlUsageSource(
      fixtureRoot,
      "codex_sessions",
      "codex_sessions_missing"
    );
    const snapshot = buildAggregate(result.records, {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "custom",
      now: new Date("2026-05-15T12:00:00.000Z"),
      warnings: result.warnings
    });

    expect(snapshot.periods.today.input_tokens).toBe(220);
    expect(snapshot.periods.today.output_tokens).toBe(110);
    expect(snapshot.collector.codex_home).toBe("custom");
    expect(snapshot.collector.warnings).toContainEqual({
      code: "malformed_records_skipped",
      severity: "warning",
      count: 2
    });
  });
});
