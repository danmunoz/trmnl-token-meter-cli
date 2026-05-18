import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import type { SessionUsageRecord } from "../src/types.js";

const record = (overrides: Partial<SessionUsageRecord> = {}): SessionUsageRecord => ({
  dedupe_key: "s1:2026-05-15T10:00:00.000Z:gpt-5:100:10:50",
  source_kind: "codex_sessions",
  occurred_at: new Date("2026-05-15T10:00:00.000Z"),
  local_date: "2026-05-15",
  model: "gpt-5",
  model_alias: "gpt-5",
  input_tokens: 100,
  cached_input_tokens: 10,
  output_tokens: 50,
  long_context: false,
  priority_tier: "base",
  pricing_known: true,
  ...overrides
});

describe("cost aggregation windows", () => {
  it("uses captured local-day windows for today, last 7 days, and last 30 days", () => {
    const snapshot = buildAggregate(
      [
        record(),
        record({
          dedupe_key: "s2",
          occurred_at: new Date("2026-05-09T10:00:00.000Z"),
          local_date: "2026-05-09"
        }),
        record({
          dedupe_key: "s3",
          occurred_at: new Date("2026-04-16T10:00:00.000Z"),
          local_date: "2026-04-16"
        }),
        record({
          dedupe_key: "s4",
          occurred_at: new Date("2026-04-15T10:00:00.000Z"),
          local_date: "2026-04-15"
        })
      ],
      {
        machineId: "mach",
        machineLabel: "Machine",
        codexHomeKind: "default",
        now: new Date("2026-05-15T12:00:00.000Z")
      }
    );

    expect(snapshot.periods.today.total_tokens).toBe(150);
    expect(snapshot.periods.last_7_days.total_tokens).toBe(300);
    expect(snapshot.periods.last_30_days.total_tokens).toBe(450);
    expect(snapshot.daily).toHaveLength(31);
  });

  it("keeps known token totals with partial warning codes", () => {
    const snapshot = buildAggregate(
      [
        record(),
        record({
          dedupe_key: "unknown",
          model: "private-model",
          pricing_known: false,
          priority_tier: "unknown"
        })
      ],
      {
        machineId: "mach",
        machineLabel: "Machine",
        codexHomeKind: "default",
        now: new Date("2026-05-15T12:00:00.000Z")
      }
    );

    expect(snapshot.periods.today.total_tokens).toBe(300);
    expect(snapshot.periods.today.cost_status).toBe("partial");
    expect(snapshot.periods.today.warning_codes).toContain("unknown_pricing");
    expect(snapshot.periods.today.warning_codes).toContain("priority_evidence_missing");
  });

  it("deduplicates repeated session-turn records", () => {
    const snapshot = buildAggregate([record(), record()], {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "default",
      now: new Date("2026-05-15T12:00:00.000Z")
    });

    expect(snapshot.periods.today.total_tokens).toBe(150);
    expect(snapshot.collector.warnings).toContainEqual({
      code: "duplicate_records_skipped",
      severity: "warning",
      count: 1
    });
  });
});
