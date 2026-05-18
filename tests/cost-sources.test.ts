import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { readPriorityEvidence } from "../src/cost-sources/priority-sqlite.js";
import { scanLocalCostSources } from "../src/cost-scan.js";

const makeTempRoot = async () => {
  const root = join(tmpdir(), `trmnl-token-meter-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
};

const writeJsonl = async (path: string, lines: string[]) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`);
};

const usageLine = (sessionId: string, timestamp = "2026-05-15T10:00:00.000Z") =>
  JSON.stringify({
    timestamp,
    session_id: sessionId,
    model: "gpt-5",
    last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50 }
  });

describe("local cost sources", () => {
  it("reads active and archived Codex sessions", async () => {
    const root = await makeTempRoot();
    await writeJsonl(join(root, "sessions", "2026", "05", "15", "active.jsonl"), [
      usageLine("active")
    ]);
    await writeJsonl(join(root, "archived_sessions", "archive.jsonl"), [usageLine("archive")]);

    const result = await scanLocalCostSources(loadConfig({ CODEX_HOME: root }));

    expect(result.records.map((record) => record.source_kind).sort()).toEqual([
      "codex_archived_sessions",
      "codex_sessions"
    ]);
    expect(result.sources).toContainEqual({
      kind: "codex_sessions",
      enabled: true,
      status: "read",
      record_count: 1
    });
  });

  it("converts cumulative Codex token snapshots to deltas before cost aggregation", async () => {
    const root = await makeTempRoot();
    await writeJsonl(join(root, "sessions", "2026", "05", "15", "cumulative.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: { session_id: "cumulative-session" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:00:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 50
            }
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:01:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 140,
              cached_input_tokens: 15,
              output_tokens: 70
            }
          }
        }
      })
    ]);

    const result = await scanLocalCostSources(loadConfig({ CODEX_HOME: root }));

    expect(result.records).toHaveLength(2);
    expect(result.records.map((item) => item.input_tokens)).toEqual([100, 40]);
    expect(result.records.map((item) => item.cached_input_tokens)).toEqual([10, 5]);
    expect(result.records.map((item) => item.output_tokens)).toEqual([50, 20]);
  });

  it("skips duplicate Codex session files with the same session metadata id", async () => {
    const root = await makeTempRoot();
    const original = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "duplicate-session" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:00:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 50
            }
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:01:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 140,
              cached_input_tokens: 15,
              output_tokens: 70
            }
          }
        }
      })
    ];
    const duplicate = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "duplicate-session" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:02:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 10_000,
              cached_input_tokens: 9_000,
              output_tokens: 1_000
            }
          }
        }
      })
    ];
    await writeJsonl(join(root, "sessions", "2026", "05", "15", "a-original.jsonl"), original);
    await writeJsonl(join(root, "sessions", "2026", "05", "15", "b-duplicate.jsonl"), duplicate);

    const result = await scanLocalCostSources(loadConfig({ CODEX_HOME: root }));

    expect(result.records).toHaveLength(2);
    expect(result.records.reduce((total, item) => total + item.input_tokens + item.output_tokens, 0)).toBe(
      210
    );
    expect(result.warnings).toContainEqual({
      code: "duplicate_records_skipped",
      severity: "warning",
      count: 1
    });
  });

  it("keeps the first session metadata id when a file repeats session metadata", async () => {
    const root = await makeTempRoot();
    await writeJsonl(join(root, "sessions", "2026", "05", "15", "parent.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "parent-session" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:00:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 50
            }
          }
        }
      })
    ]);
    await writeJsonl(join(root, "sessions", "2026", "05", "15", "subagent.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "child-session" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:01:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 25,
              cached_input_tokens: 5,
              output_tokens: 10
            }
          }
        }
      }),
      JSON.stringify({
        type: "session_meta",
        payload: { id: "parent-session" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:02:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 40,
              cached_input_tokens: 8,
              output_tokens: 15
            }
          }
        }
      })
    ]);

    const result = await scanLocalCostSources(loadConfig({ CODEX_HOME: root }));

    expect(result.records).toHaveLength(3);
    expect(result.records.reduce((total, item) => total + item.input_tokens + item.output_tokens, 0)).toBe(
      205
    );
    expect(result.warnings.find((item) => item.code === "duplicate_records_skipped")).toBeUndefined();
  });

  it("subtracts inherited parent totals from forked cumulative Codex sessions", async () => {
    const root = await makeTempRoot();
    await writeJsonl(join(root, "sessions", "2026", "05", "15", "parent.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "parent-session" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:00:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 10,
              output_tokens: 50
            }
          }
        }
      })
    ]);
    await writeJsonl(join(root, "sessions", "2026", "05", "15", "child.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: "child-session",
          forked_from_id: "parent-session",
          timestamp: "2026-05-15T10:00:30.000Z"
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:01:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 125,
              cached_input_tokens: 15,
              output_tokens: 60
            }
          }
        }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:02:00.000Z",
        payload: {
          type: "token_count",
          info: {
            model: "gpt-5",
            total_token_usage: {
              input_tokens: 140,
              cached_input_tokens: 18,
              output_tokens: 70
            }
          }
        }
      })
    ]);

    const result = await scanLocalCostSources(loadConfig({ CODEX_HOME: root }));

    expect(result.records).toHaveLength(3);
    expect(result.records.map((item) => item.input_tokens).sort((a, b) => a - b)).toEqual([
      15,
      25,
      100
    ]);
    expect(result.records.map((item) => item.output_tokens).sort((a, b) => a - b)).toEqual([
      10,
      10,
      50
    ]);
  });

  it("keeps Pi disabled by default and merges Pi only when enabled", async () => {
    const root = await makeTempRoot();
    const piRoot = await makeTempRoot();
    await writeJsonl(join(root, "sessions", "active.jsonl"), [usageLine("active")]);
    await writeJsonl(join(piRoot, "agent", "sessions", "pi.jsonl"), [usageLine("pi")]);

    const disabled = await scanLocalCostSources(loadConfig({ CODEX_HOME: root, PI_HOME: piRoot }));
    const enabled = await scanLocalCostSources(
      loadConfig({
        CODEX_HOME: root,
        PI_HOME: piRoot,
        TRMNL_TOKEN_METER_INCLUDE_PI_SESSIONS: "1"
      })
    );

    expect(disabled.records.map((record) => record.source_kind)).toEqual(["codex_sessions"]);
    expect(disabled.sources).toContainEqual({
      kind: "pi_sessions",
      enabled: false,
      status: "disabled"
    });
    expect(enabled.records.map((record) => record.source_kind).sort()).toEqual([
      "codex_sessions",
      "pi_sessions"
    ]);
  });

  it("reads matched priority evidence without exposing row content", async () => {
    const root = await makeTempRoot();
    const sqlite = (await import("node:sqlite")) as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const db = new sqlite.DatabaseSync(join(root, "logs_2.sqlite"));
    db.exec("create table usage_priority (match_key text, tier text)");
    db.exec("insert into usage_priority values ('active', 'priority')");
    db.close();

    const result = await readPriorityEvidence(loadConfig({ CODEX_HOME: root }));

    expect(result.evidence).toEqual([
      { match_key: "active", tier: "priority", confidence: "exact" }
    ]);
    expect(JSON.stringify(result)).not.toContain("usage_priority");
  });
});
