import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { discoverCodexJsonlFiles, readCodexUsage } from "../src/codex-log-reader.js";
import { buildAggregate } from "../src/aggregate.js";

const fixtureRoot = new URL("./fixtures/codex-jsonl/default", import.meta.url).pathname;
const nestedFixtureRoot = new URL("./fixtures/codex-jsonl/nested", import.meta.url).pathname;

describe("Codex JSONL reader", () => {
  it("discovers jsonl files under the configured Codex home", async () => {
    const config = loadConfig({ CODEX_HOME: fixtureRoot });
    const files = await discoverCodexJsonlFiles(config);
    expect(files.map((file) => file.split("/").pop()).sort()).toEqual([
      "malformed.jsonl",
      "session.jsonl"
    ]);
  });

  it("normalizes token events and reports malformed lines generically", async () => {
    const config = loadConfig({ CODEX_HOME: fixtureRoot });
    const result = await readCodexUsage(config);

    expect(result.events).toHaveLength(3);
    expect(result.events[2]?.cached_input_tokens).toBe(25);
    expect(result.warnings).toContainEqual({
      code: "malformed_records_skipped",
      severity: "warning",
      count: 2
    });
    expect(JSON.stringify(result.warnings)).not.toContain(fixtureRoot);
  });

  it("warns when Codex home is missing without exposing the path", async () => {
    const result = await readCodexUsage(loadConfig({ CODEX_HOME: "/tmp/not-present-codex-home" }));
    expect(result.events).toEqual([]);
    expect(result.warnings).toEqual([{ code: "codex_sessions_missing", severity: "warning" }]);
  });

  it("normalizes CodexBar-style event_msg token counts with turn context", async () => {
    const result = await readCodexUsage(loadConfig({ CODEX_HOME: nestedFixtureRoot }));

    expect(result.events).toHaveLength(3);
    expect(result.events[0]).toMatchObject({
      session_id: "nested-s1",
      model: "gpt-5.4-codex",
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 50,
      record_kind: "cumulative"
    });
    expect(result.events[1]).toMatchObject({
      model: "gpt-5.4-codex",
      cached_input_tokens: 30,
      record_kind: "cumulative"
    });
    expect(result.events[2]).toMatchObject({
      model: "gpt-5.4-mini",
      input_tokens: 25,
      cached_input_tokens: 5,
      output_tokens: 10,
      record_kind: "delta"
    });

    const snapshot = buildAggregate(result.events, {
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
