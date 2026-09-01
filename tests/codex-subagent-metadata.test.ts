import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { readJsonlUsageSource } from "../src/cost-sources/jsonl.js";

describe("legacy Codex subagent metadata", () => {
  it("enriches the first leaf metadata from a later same-leaf record", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-token-meter-codex-jsonl-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "session.jsonl"),
      [
        {
          ordinal: 1,
          type: "session_meta",
          payload: { id: "child", source: { subagent: "review" } }
        },
        {
          ordinal: 2,
          timestamp: "2026-05-15T08:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { total_token_usage: { input_tokens: 100 } }
          }
        },
        {
          ordinal: 3,
          type: "session_meta",
          payload: {
            id: "child",
            forked_from_id: "parent",
            subagent_history_start_ordinal: 4
          }
        },
        {
          ordinal: 4,
          timestamp: "2026-05-15T08:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 120 },
              last_token_usage: { input_tokens: 20 }
            }
          }
        }
      ].map((record) => JSON.stringify(record)).join("\n")
    );

    const result = await readJsonlUsageSource(
      root,
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

    expect(result.records).toHaveLength(1);
    expect(snapshot.periods.today.total_tokens).toBe(20);
  });
});
