import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
        cached_input_tokens: 40,
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
    expect(snapshot.periods.today.total_tokens).toBe(290);
    expect(JSON.stringify(snapshot.periods.today)).not.toContain("input_tokens");
    expect(JSON.stringify(snapshot.periods.today)).not.toContain("cached_input_tokens");
    expect(JSON.stringify(snapshot.periods.today)).not.toContain("output_tokens");
    expect(JSON.stringify(snapshot.periods.today)).not.toContain("token_breakdown");
    expect(snapshot.models.map((model) => model.name)).toEqual(["gpt-5.4-codex", "gpt-5.4-mini"]);
  });

  it("prefers per-turn last_token_usage when cumulative totals diverge", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-token-meter-codex-jsonl-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "session.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-15T08:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "s-divergent" }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:01:00.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.4-codex" }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:02:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1_300,
                cached_input_tokens: 300,
                output_tokens: 130
              },
              last_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 200,
                output_tokens: 100
              }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:03:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 1_900,
                cached_input_tokens: 450,
                output_tokens: 190
              },
              last_token_usage: {
                input_tokens: 500,
                cached_input_tokens: 100,
                output_tokens: 50
              }
            }
          }
        })
      ].join("\n")
    );

    const result = await readCodexFixture(root);
    const snapshot = buildAggregate(result.records, {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "custom",
      now: new Date("2026-05-15T12:00:00.000Z"),
      warnings: result.warnings
    });

    expect(snapshot.periods.today.total_tokens).toBe(1_650);
    expect(JSON.stringify(snapshot.periods.today)).not.toContain("input_tokens");
    expect(JSON.stringify(snapshot.periods.today)).not.toContain("cached_input_tokens");
    expect(JSON.stringify(snapshot.periods.today)).not.toContain("output_tokens");
    expect(JSON.stringify(snapshot.periods.today)).not.toContain("token_breakdown");
  });

  it("does not add cached input tokens to aggregate token totals", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-token-meter-codex-jsonl-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "session.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-15T08:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "s-cached" }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:01:00.000Z",
          type: "turn_context",
          payload: { model: "gpt-5.4-codex" }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:02:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: {
                input_tokens: 100_000_000,
                cached_input_tokens: 43_400_000,
                output_tokens: 40_000_000
              }
            }
          }
        })
      ].join("\n")
    );

    const result = await readCodexFixture(root);
    const snapshot = buildAggregate(result.records, {
      machineId: "mach",
      machineLabel: "Machine",
      codexHomeKind: "custom",
      now: new Date("2026-05-15T12:00:00.000Z"),
      warnings: result.warnings
    });

    expect(snapshot.periods.today.total_tokens).toBe(140_000_000);
    expect(snapshot.models[0]?.total_tokens).toBe(140_000_000);
    expect(JSON.stringify(snapshot)).not.toContain("input_tokens");
    expect(JSON.stringify(snapshot)).not.toContain("cached_input_tokens");
    expect(JSON.stringify(snapshot)).not.toContain("output_tokens");
    expect(JSON.stringify(snapshot)).not.toContain("token_breakdown");
  });
});
