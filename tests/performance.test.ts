import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { readJsonlUsageSource } from "../src/cost-sources/jsonl.js";

const fixtureRoot = new URL("./fixtures/codex-jsonl/default", import.meta.url).pathname;

describe("collector performance", () => {
  it("completes typical one-shot collection well under 10 seconds", async () => {
    const started = performance.now();
    const result = await readJsonlUsageSource(
      fixtureRoot,
      "codex_sessions",
      "codex_sessions_missing"
    );
    buildAggregate(result.records, {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "default",
      now: new Date("2026-05-15T12:00:00.000Z")
    });
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
