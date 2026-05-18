import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { loadConfig } from "../src/config.js";
import { scanLocalCostSources } from "../src/cost-scan.js";
import { serializeAggregateForUpload } from "../src/upload.js";

const fixtureRoot = new URL("./fixtures/codex-jsonl/default", import.meta.url).pathname;

const canaries = [
  "CANARY_PROMPT_DO_NOT_UPLOAD",
  "CANARY_RESPONSE_DO_NOT_UPLOAD",
  "CANARY_TOOL_OUTPUT_DO_NOT_UPLOAD",
  "/Users/danielmunoz/Repos/private-project",
  "cat /Users/danielmunoz/.ssh/id_rsa"
];

describe("privacy canaries", () => {
  it("keeps raw Codex content out of production upload serialization", async () => {
    const config = loadConfig({ CODEX_HOME: fixtureRoot });
    const result = await scanLocalCostSources(config);
    const snapshot = buildAggregate(result.records, {
      machineId: "mach_1",
      machineLabel: "Daniel MacBook",
      codexHomeKind: "default",
      now: new Date("2026-05-15T12:00:00.000Z"),
      sources: result.sources,
      warnings: result.warnings
    });

    const serialized = serializeAggregateForUpload({
      ...snapshot,
      // @ts-expect-error deliberate privacy canary proving allowlist serialization.
      prompt: "CANARY_PROMPT_DO_NOT_UPLOAD"
    });

    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
    expect(JSON.parse(serialized)).toEqual(snapshot);
  });
});
