import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { loadConfig } from "../src/config.js";
import { readCodexUsage } from "../src/codex-log-reader.js";

const fixtureRoot = new URL("./fixtures/codex-jsonl/default", import.meta.url).pathname;

describe("collector performance", () => {
  it("completes typical one-shot collection well under 10 seconds", async () => {
    const started = performance.now();
    const result = await readCodexUsage(loadConfig({ CODEX_HOME: fixtureRoot }));
    buildAggregate(result.events, {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "default",
      now: new Date("2026-05-15T12:00:00.000Z")
    });
    expect(performance.now() - started).toBeLessThan(10_000);
  });
});
