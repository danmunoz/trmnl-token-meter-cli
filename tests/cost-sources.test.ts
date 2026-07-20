import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { readOpenCodeSqliteSource } from "../src/cost-sources/opencode-sqlite.js";
import { localDateKey } from "../src/cost-sources/jsonl.js";
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

const loadTestConfig = (env: NodeJS.ProcessEnv) =>
  loadConfig({
    TRMNL_TOKEN_METER_OPENCODE_DB: join(String(env.CODEX_HOME ?? tmpdir()), "missing-opencode.db"),
    TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: join(String(env.CODEX_HOME ?? tmpdir()), "missing-claude"),
    ...env
  });

const usageLine = (sessionId: string, timestamp = "2026-05-15T10:00:00.000Z") =>
  JSON.stringify({
    timestamp,
    session_id: sessionId,
    model: "gpt-5",
    last_token_usage: { input_tokens: 100, cached_input_tokens: 10, output_tokens: 50 }
  });

interface OpenCodeMessageFixture {
  id: string;
  session_id?: string;
  time_created: string | number;
  model: string;
  providerID?: string;
  tokens_input: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  tokens_output: number;
  tokens_reasoning: number;
  cost?: number;
}

// OpenCode stores per-turn usage on `message` rows (role="assistant") with a JSON
// `data` blob. The `session` table below carries canary columns to prove the reader
// never falls back to session-level rollups (which are misdated and often empty).
const createOpenCodeDb = async (path: string, messages: OpenCodeMessageFixture[]) => {
  const sqlite = (await import("node:sqlite")) as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...values: unknown[]): void;
      };
      close(): void;
    };
  };
  const db = new sqlite.DatabaseSync(path);
  db.exec(`
    create table session (
      id text primary key,
      time_created text,
      title text,
      directory text,
      tokens_input integer
    )
  `);
  db.prepare(
    `insert into session (id, time_created, title, directory, tokens_input) values (?, ?, ?, ?, ?)`
  ).run(
    "canary-session",
    "2026-05-15T00:00:00.000Z",
    "CANARY_TITLE_DO_NOT_UPLOAD",
    "CANARY_DIRECTORY_DO_NOT_UPLOAD",
    999_999
  );
  db.exec(`
    create table message (
      id text primary key,
      session_id text,
      time_created integer,
      time_updated integer,
      data text
    )
  `);
  const statement = db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)`
  );
  for (const message of messages) {
    const created =
      typeof message.time_created === "number" ? message.time_created : Date.parse(message.time_created);
    const data = {
      role: "assistant",
      modelID: message.model,
      providerID: message.providerID ?? "openai",
      path: "CANARY_PATH_DO_NOT_UPLOAD",
      summary: "CANARY_SUMMARY_DO_NOT_UPLOAD",
      time: { created },
      ...(message.cost === undefined ? {} : { cost: message.cost }),
      tokens: {
        input: message.tokens_input,
        output: message.tokens_output,
        reasoning: message.tokens_reasoning,
        cache: { read: message.tokens_cache_read, write: message.tokens_cache_write }
      }
    };
    statement.run(message.id, message.session_id ?? "session-1", created, created, JSON.stringify(data));
  }
  db.close();
};

describe("local cost sources", () => {
  it("reads active and archived Codex sessions", async () => {
    const root = await makeTempRoot();
    await writeJsonl(join(root, "sessions", "2026", "05", "15", "active.jsonl"), [
      usageLine("active")
    ]);
    await writeJsonl(join(root, "archived_sessions", "archive.jsonl"), [usageLine("archive")]);

    const result = await scanLocalCostSources(loadTestConfig({ CODEX_HOME: root }));

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

    const result = await scanLocalCostSources(loadTestConfig({ CODEX_HOME: root }));

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

    const result = await scanLocalCostSources(loadTestConfig({ CODEX_HOME: root }));

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

    const result = await scanLocalCostSources(loadTestConfig({ CODEX_HOME: root }));

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

    const result = await scanLocalCostSources(loadTestConfig({ CODEX_HOME: root }));

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

    const disabled = await scanLocalCostSources(loadTestConfig({ CODEX_HOME: root, PI_HOME: piRoot }));
    const enabled = await scanLocalCostSources(
      loadTestConfig({
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

  it("reads OpenCode SQLite sessions as a separate source provider", async () => {
    const root = await makeTempRoot();
    const opencodeRoot = await makeTempRoot();
    const opencodeDb = join(opencodeRoot, "opencode.db");
    await writeJsonl(join(root, "sessions", "active.jsonl"), [usageLine("active")]);
    await createOpenCodeDb(opencodeDb, [
      {
        id: "opencode-message-1",
        time_created: "2026-05-15T11:00:00.000Z",
        model: "openai/gpt-5",
        tokens_input: 120,
        tokens_cache_read: 7,
        tokens_cache_write: 11,
        tokens_output: 40,
        tokens_reasoning: 13,
        cost: 0.123456
      },
      {
        id: "opencode-message-2",
        time_created: "2026-05-15T12:00:00.000Z",
        model: "gpt-5-mini",
        tokens_input: 80,
        tokens_cache_read: 3,
        tokens_cache_write: 5,
        tokens_output: 20,
        tokens_reasoning: 2,
        cost: 0.118197
      }
    ]);

    const result = await scanLocalCostSources(
      loadTestConfig({
        CODEX_HOME: root,
        TRMNL_TOKEN_METER_OPENCODE_DB: opencodeDb,
        TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,opencode"
      })
    );

    const opencode = result.records
      .filter((record) => record.source_provider === "opencode")
      .sort((a, b) => a.dedupe_key.localeCompare(b.dedupe_key));
    expect(opencode).toHaveLength(2);
    expect(opencode[0]).toMatchObject({
      dedupe_key: "opencode:opencode-message-1",
      source_provider: "opencode",
      source_kind: "opencode_sqlite",
      input_tokens: 120,
      cached_input_tokens: 7,
      output_tokens: 53,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 11,
      observed_cost_usd: 0.123456,
      model: "gpt-5",
      model_alias: "gpt-5",
      priority_tier: "base"
    });
    expect(opencode[1]).toMatchObject({
      dedupe_key: "opencode:opencode-message-2",
      model: "gpt-5-mini",
      model_alias: "gpt-5-mini",
      input_tokens: 80,
      cached_input_tokens: 3,
      output_tokens: 22,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 5,
      observed_cost_usd: 0.118197
    });
    expect(result.sources).toContainEqual({
      kind: "opencode_sqlite",
      enabled: true,
      status: "read",
      record_count: 2
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain("CANARY_TITLE_DO_NOT_UPLOAD");
    expect(text).not.toContain("CANARY_DIRECTORY_DO_NOT_UPLOAD");
    expect(text).not.toContain("CANARY_PATH_DO_NOT_UPLOAD");
    expect(text).not.toContain("CANARY_SUMMARY_DO_NOT_UPLOAD");
  });

  it("attributes OpenCode usage to each message's date, not the session creation date", async () => {
    const root = await makeTempRoot();
    const opencodeRoot = await makeTempRoot();
    const opencodeDb = join(opencodeRoot, "opencode.db");
    await writeJsonl(join(root, "sessions", "active.jsonl"), [usageLine("active")]);
    // A single long-lived session (created day one) reused across three days.
    await createOpenCodeDb(opencodeDb, [
      {
        id: "msg-day1",
        session_id: "long-session",
        time_created: "2026-05-10T12:00:00.000Z",
        model: "gpt-5",
        tokens_input: 100,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        tokens_output: 10,
        tokens_reasoning: 0
      },
      {
        id: "msg-day3",
        session_id: "long-session",
        time_created: "2026-05-12T12:00:00.000Z",
        model: "gpt-5",
        tokens_input: 200,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        tokens_output: 20,
        tokens_reasoning: 0
      },
      {
        id: "msg-day11",
        session_id: "long-session",
        time_created: "2026-05-20T12:00:00.000Z",
        model: "gpt-5",
        tokens_input: 300,
        tokens_cache_read: 0,
        tokens_cache_write: 0,
        tokens_output: 30,
        tokens_reasoning: 0
      }
    ]);

    const result = await scanLocalCostSources(
      loadTestConfig({
        CODEX_HOME: root,
        TRMNL_TOKEN_METER_OPENCODE_DB: opencodeDb,
        TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,opencode"
      })
    );

    const opencode = result.records
      .filter((record) => record.source_provider === "opencode")
      .sort((a, b) => a.occurred_at.getTime() - b.occurred_at.getTime());
    expect(opencode.map((record) => record.dedupe_key)).toEqual([
      "opencode:msg-day1",
      "opencode:msg-day3",
      "opencode:msg-day11"
    ]);
    // Each record is dated to its own message, spanning three distinct days —
    // not lumped onto the session's creation date.
    expect(opencode.map((record) => record.local_date)).toEqual([
      localDateKey(new Date("2026-05-10T12:00:00.000Z")),
      localDateKey(new Date("2026-05-12T12:00:00.000Z")),
      localDateKey(new Date("2026-05-20T12:00:00.000Z"))
    ]);
    expect(new Set(opencode.map((record) => record.local_date)).size).toBe(3);
    expect(opencode.map((record) => record.input_tokens)).toEqual([100, 200, 300]);
  });

  it("does not read disabled OpenCode or Claude providers and returns disabled source statuses", async () => {
    const root = await makeTempRoot();
    const opencodeRoot = await makeTempRoot();
    const claudeConfigRoot = await makeTempRoot();
    const opencodeDb = join(opencodeRoot, "opencode.db");
    await createOpenCodeDb(opencodeDb, [
      {
        id: "opencode-message-1",
        time_created: "2026-05-15T11:00:00.000Z",
        model: "openai/gpt-5",
        tokens_input: 100,
        tokens_cache_read: 50,
        tokens_cache_write: 10,
        tokens_output: 25,
        tokens_reasoning: 5,
        cost: 0.123456
      }
    ]);
    await writeJsonl(join(claudeConfigRoot, "projects", "project-a", "stream.jsonl"), [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T11:00:00.000Z",
        sessionId: "claude-session-1",
        requestId: "req_stream",
        isSidechain: false,
        message: {
          id: "msg_stream",
          model: "claude-sonnet-4-5-20250929",
          usage: {
            input_tokens: 50,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 2,
            output_tokens: 19
          },
          content: "CANARY_RESPONSE_DO_NOT_UPLOAD"
        }
      })
    ]);
    await writeJsonl(join(root, "sessions", "active.jsonl"), [
      usageLine("codex-disabled")
    ]);

    const result = await scanLocalCostSources(
      loadTestConfig({
        CODEX_HOME: root,
        TRMNL_TOKEN_METER_OPENCODE_DB: opencodeDb,
        TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: claudeConfigRoot,
        TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex"
      })
    );

    expect(result.records.map((record) => record.source_provider)).toEqual(["codex"]);
    expect(result.sources).toContainEqual({
      kind: "opencode_sqlite",
      enabled: false,
      status: "disabled"
    });
    expect(result.sources).toContainEqual({
      kind: "claude_projects",
      enabled: false,
      status: "disabled"
    });
    expect(JSON.stringify(result)).not.toContain("CANARY_RESPONSE_DO_NOT_UPLOAD");
  });

  it("reports missing, unreadable, and malformed OpenCode SQLite status without exposing SQL details", async () => {
    const root = await makeTempRoot();
    const unreadableDb = join(root, "unreadable.db");
    const malformedDb = join(root, "malformed.db");
    await createOpenCodeDb(unreadableDb, []);
    await chmod(unreadableDb, 0o000);
    await createOpenCodeDb(malformedDb, []);
    const sqlite = (await import("node:sqlite")) as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const db = new sqlite.DatabaseSync(malformedDb);
    db.exec("drop table message");
    db.close();

    const missing = await readOpenCodeSqliteSource(loadConfig({ TRMNL_TOKEN_METER_OPENCODE_DB: join(root, "missing.db") }));
    const unreadable = await readOpenCodeSqliteSource(loadConfig({ TRMNL_TOKEN_METER_OPENCODE_DB: unreadableDb }));
    await chmod(unreadableDb, 0o600);
    const malformed = await readOpenCodeSqliteSource(loadConfig({ TRMNL_TOKEN_METER_OPENCODE_DB: malformedDb }));

    expect(missing).toMatchObject({
      records: [],
      status: {
        kind: "opencode_sqlite",
        enabled: true,
        status: "missing",
        warning_code: "opencode_sqlite_missing"
      },
      warnings: [{ code: "opencode_sqlite_missing", severity: "warning" }]
    });
    expect(unreadable).toMatchObject({
      records: [],
      status: {
        kind: "opencode_sqlite",
        enabled: true,
        status: "unreadable",
        warning_code: "opencode_sqlite_unreadable"
      },
      warnings: [{ code: "opencode_sqlite_unreadable", severity: "warning" }]
    });
    expect(malformed).toMatchObject({
      records: [],
      status: {
        kind: "opencode_sqlite",
        enabled: true,
        status: "malformed",
        warning_code: "opencode_sqlite_malformed"
      },
      warnings: [{ code: "opencode_sqlite_malformed", severity: "warning" }]
    });
    expect(JSON.stringify(malformed)).not.toContain("title");
  });

  it("reads Claude assistant usage with CodexBar streaming and privacy behavior", async () => {
    const root = await makeTempRoot();
    const claudeConfigRoot = await makeTempRoot();
    await writeJsonl(join(root, "sessions", "active.jsonl"), [usageLine("active")]);
    await writeJsonl(join(claudeConfigRoot, "projects", "project-a", "stream.jsonl"), [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T11:00:00.000Z",
        sessionId: "claude-session-1",
        requestId: "req_stream",
        isSidechain: false,
        message: {
          id: "msg_stream",
          model: "claude-sonnet-4-5-20250929",
          usage: {
            input_tokens: 50,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 2,
            output_tokens: 7
          },
          content: "CANARY_RESPONSE_DO_NOT_UPLOAD"
        }
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T11:00:01.000Z",
        sessionId: "claude-session-1",
        requestId: "req_stream",
        isSidechain: false,
        message: {
          id: "msg_stream",
          model: "claude-sonnet-4-5-20250929",
          usage: {
            input_tokens: 50,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 2,
            output_tokens: 19
          },
          content: "CANARY_RESPONSE_DO_NOT_UPLOAD"
        }
      })
    ]);

    const result = await scanLocalCostSources(
      loadTestConfig({
        CODEX_HOME: root,
        TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: claudeConfigRoot,
        TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,claude"
      })
    );

    const claude = result.records.find((record) => record.source_provider === "claude");
    expect(claude).toMatchObject({
      source_provider: "claude",
      source_kind: "claude_projects",
      input_tokens: 50,
      cached_input_tokens: 2,
      output_tokens: 19,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 2,
      model: "claude-sonnet-4-5"
    });
    expect(claude).not.toHaveProperty("token_breakdown");
    expect(JSON.stringify(result)).not.toContain("CANARY_RESPONSE_DO_NOT_UPLOAD");
  });

  it("excludes Vertex AI-formatted Claude rows from the Claude source", async () => {
    const root = await makeTempRoot();
    const claudeConfigRoot = await makeTempRoot();
    await writeJsonl(join(claudeConfigRoot, "projects", "project-a", "vertex.jsonl"), [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T11:00:00.000Z",
        requestId: "req_vrtx_vertex",
        metadata: { provider: "vertexai", projectId: "vertex-project" },
        message: {
          id: "msg_vrtx_vertex",
          model: "claude-opus-4-5@20251101",
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 50
          }
        }
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T11:01:00.000Z",
        requestId: "req_anthropic",
        metadata: { provider: "anthropic" },
        message: {
          id: "msg_anthropic",
          model: "claude-opus-4-5-20251101",
          usage: {
            input_tokens: 200,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 100
          }
        }
      })
    ]);

    const result = await scanLocalCostSources(
      loadTestConfig({
        CODEX_HOME: root,
        TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: claudeConfigRoot,
        TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,claude"
      })
    );

    const claudeRecords = result.records.filter((record) => record.source_provider === "claude");
    expect(claudeRecords).toHaveLength(1);
    expect(claudeRecords[0]).toMatchObject({
      model: "claude-opus-4-5",
      input_tokens: 200,
      output_tokens: 100
    });
    expect(JSON.stringify(result)).not.toContain("vertex-project");
  });

  it("marks unknown Claude models as unknown pricing", async () => {
    const root = await makeTempRoot();
    const claudeConfigRoot = await makeTempRoot();
    await writeJsonl(join(claudeConfigRoot, "projects", "project-a", "unknown-model.jsonl"), [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T11:00:00.000Z",
        requestId: "req_unknown",
        message: {
          id: "msg_unknown",
          model: "private-claude-model",
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 50
          }
        }
      })
    ]);

    const result = await scanLocalCostSources(
      loadTestConfig({
        CODEX_HOME: root,
        TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: claudeConfigRoot,
        TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,claude"
      })
    );

    const claude = result.records.find((record) => record.source_provider === "claude");
    expect(claude).toMatchObject({
      model: "private-claude-model",
      pricing_known: false
    });
  });

  it("deduplicates copied Claude transcript history across files while keeping new rows", async () => {
    const root = await makeTempRoot();
    const claudeConfigRoot = await makeTempRoot();
    await writeJsonl(join(root, "sessions", "active.jsonl"), [usageLine("active")]);

    const copied = {
      type: "assistant",
      timestamp: "2026-05-15T11:00:00.000Z",
      requestId: "req_copied",
      isSidechain: false,
      message: {
        id: "msg_copied",
        model: "claude-sonnet-4-5",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 10,
          output_tokens: 30
        }
      }
    };
    await writeJsonl(join(claudeConfigRoot, "projects", "project-a", "original.jsonl"), [
      JSON.stringify({ ...copied, sessionId: "original" }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T11:01:00.000Z",
        sessionId: "original",
        requestId: "req_original_new",
        message: {
          id: "msg_original_new",
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 40,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 10
          }
        }
      })
    ]);
    await writeJsonl(join(claudeConfigRoot, "projects", "project-a", "fork.jsonl"), [
      JSON.stringify({ ...copied, sessionId: "fork" }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T11:02:00.000Z",
        sessionId: "fork",
        requestId: "req_fork_new",
        message: {
          id: "msg_fork_new",
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 70,
            cache_creation_input_tokens: 5,
            cache_read_input_tokens: 0,
            output_tokens: 20
          }
        }
      })
    ]);

    const result = await scanLocalCostSources(
      loadTestConfig({
        CODEX_HOME: root,
        TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: claudeConfigRoot,
        TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,claude"
      })
    );

    const claudeRecords = result.records.filter((record) => record.source_provider === "claude");
    expect(claudeRecords).toHaveLength(3);
    expect(claudeRecords.reduce((total, record) => total + record.input_tokens, 0)).toBe(210);
    expect(
      claudeRecords.reduce((total, record) => total + (record.cache_creation_input_tokens ?? 0), 0)
    ).toBe(25);
    expect(claudeRecords.reduce((total, record) => total + record.cached_input_tokens, 0)).toBe(10);
    expect(claudeRecords.reduce((total, record) => total + record.output_tokens, 0)).toBe(60);
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

  it("matches Codex priority trace evidence to token rows by turn id", async () => {
    const root = await makeTempRoot();
    const turnId = "priority-turn";
    await writeJsonl(join(root, "sessions", "2026", "05", "15", "priority.jsonl"), [
      JSON.stringify({
        type: "session_meta",
        payload: { session_id: "priority-session" }
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: "2026-05-15T10:00:00.000Z",
        payload: { model: "codex-auto-review" }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:01:00.000Z",
        payload: { type: "task_started", id: turnId }
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-05-15T10:02:00.000Z",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 10
            }
          }
        }
      })
    ]);

    const sqlite = (await import("node:sqlite")) as {
      DatabaseSync: new (path: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    const db = new sqlite.DatabaseSync(join(root, "logs_2.sqlite"));
    db.exec("create table logs (ts integer, feedback_log_body text)");
    db.exec(`
      insert into logs values (
        1778842861,
        'thread_id=thread turn.id=${turnId} websocket request: {"type":"response.create","model":"gpt-5.5","service_tier":"priority"}'
      )
    `);
    db.exec(`
      insert into logs values (
        1778842862,
        'thread_id=thread turn.id=${turnId} websocket event: {"type":"response.completed","response":{"model":"gpt-5.5"}}'
      )
    `);
    db.close();

    const result = await scanLocalCostSources(loadTestConfig({ CODEX_HOME: root }));

    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.priority_tier).toBe("priority");
    expect(result.records[0]?.model).toBe("gpt-5.5");
    expect(JSON.stringify(result)).not.toContain("response.create");
  });
});
