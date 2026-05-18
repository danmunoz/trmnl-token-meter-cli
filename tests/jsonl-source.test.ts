import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { readJsonlUsageSource } from "../src/cost-sources/jsonl.js";

const fixtureRoot = new URL("./fixtures/codex-jsonl/default", import.meta.url).pathname;
const nestedFixtureRoot = new URL("./fixtures/codex-jsonl/nested", import.meta.url).pathname;

const readCodexFixture = (root: string) =>
  readJsonlUsageSource(root, "codex_sessions", "codex_sessions_missing");

describe("Codex JSONL source", () => {
  it("discovers jsonl files under the configured Codex home", async () => {
    const result = await readCodexFixture(fixtureRoot);

    expect(result.status).toMatchObject({
      kind: "codex_sessions",
      enabled: true,
      status: "read",
      record_count: 3
    });
  });

  it("normalizes token events and reports malformed lines generically", async () => {
    const result = await readCodexFixture(fixtureRoot);

    expect(result.records).toHaveLength(3);
    expect(result.records).toContainEqual(
      expect.objectContaining({
        input_tokens: 25,
        cached_input_tokens: 25,
        output_tokens: 10
      })
    );
    expect(result.warnings).toContainEqual({
      code: "malformed_records_skipped",
      severity: "warning",
      count: 2
    });
    expect(JSON.stringify(result.warnings)).not.toContain(fixtureRoot);
  });

  it("warns when Codex home is missing without exposing the path", async () => {
    const result = await readCodexFixture("/tmp/not-present-codex-home");

    expect(result.records).toEqual([]);
    expect(result.warnings).toEqual([{ code: "codex_sessions_missing", severity: "warning" }]);
  });

  it("normalizes CodexBar-style event_msg token counts with turn context", async () => {
    const result = await readCodexFixture(nestedFixtureRoot);

    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toMatchObject({
      model: "gpt-5.4-codex",
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 50
    });
    expect(result.records[1]).toMatchObject({
      model: "gpt-5.4-codex",
      input_tokens: 75,
      cached_input_tokens: 10,
      output_tokens: 30
    });
    expect(result.records[2]).toMatchObject({
      model: "gpt-5.4-mini",
      input_tokens: 25,
      cached_input_tokens: 5,
      output_tokens: 10
    });

    const snapshot = buildAggregate(result.records, {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "custom",
      now: new Date("2026-05-15T12:00:00.000Z"),
      warnings: result.warnings
    });
    expect(snapshot.periods.today.input_tokens).toBe(200);
    expect(snapshot.periods.today.cached_input_tokens).toBe(35);
    expect(snapshot.periods.today.output_tokens).toBe(90);
    expect(snapshot.models.map((model) => model.name)).toEqual(["gpt-5.4", "gpt-5.4-mini"]);
  });
});
