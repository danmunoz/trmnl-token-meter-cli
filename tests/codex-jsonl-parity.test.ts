import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildAggregate } from "../src/aggregate.js";
import { readJsonlUsageSource } from "../src/cost-sources/jsonl.js";

const readCodexFixture = (root: string) =>
  readJsonlUsageSource(root, "codex_sessions", "codex_sessions_missing");

describe("Codex JSONL CodexBar parity", () => {
  it("suppresses repeated Codex cumulative snapshots even when last usage is non-zero", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-token-meter-codex-jsonl-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "session.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-15T08:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "s-repeated-total" }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
              last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:02:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
              last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:03:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 13 },
              last_token_usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 3 }
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

    expect(result.records).toHaveLength(2);
    expect(snapshot.periods.today.total_tokens).toBe(133);
  });

  it("suppresses stale Codex total regressions without resetting the cumulative baseline", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-token-meter-codex-jsonl-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "session.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-05-15T08:00:00.000Z",
          type: "session_meta",
          payload: { session_id: "s-stale-total" }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
              last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:02:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 99, cached_input_tokens: 89, output_tokens: 10 },
              last_token_usage: { input_tokens: 1, cached_input_tokens: 1, output_tokens: 0 }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:03:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 110, cached_input_tokens: 95, output_tokens: 12 },
              last_token_usage: { input_tokens: 10, cached_input_tokens: 5, output_tokens: 2 }
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

    expect(result.records).toHaveLength(2);
    expect(snapshot.periods.today.total_tokens).toBe(122);
  });

  it("uses deduplicated parent totals when normalizing forked cumulative usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-token-meter-codex-jsonl-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "a-parent.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "parent" } }),
        JSON.stringify({
          timestamp: "2026-05-15T08:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
              last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
              last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }
            }
          }
        })
      ].join("\n")
    );
    await writeFile(
      join(sessions, "b-child.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "child",
            forked_from_id: "parent",
            timestamp: "2026-05-15T08:01:30.000Z"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:02:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 },
              last_token_usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 10 }
            }
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:03:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 12 },
              last_token_usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 2 }
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

    expect(result.records).toHaveLength(2);
    expect(snapshot.periods.today.total_tokens).toBe(132);
  });

  it("counts only the owned suffix of a subagent rollout with embedded parent history", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-token-meter-codex-jsonl-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "a-parent.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "parent" } }),
        JSON.stringify({
          timestamp: "2026-05-15T08:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { model: "gpt-5", total_token_usage: { input_tokens: 100 } }
          }
        })
      ].join("\n")
    );
    await writeFile(
      join(sessions, "b-subagent.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "subagent",
            session_id: "parent",
            forked_from_id: "parent",
            timestamp: "2026-05-15T08:00:30.000Z",
            thread_source: "subagent"
          }
        }),
        JSON.stringify({ type: "session_meta", payload: { id: "parent", thread_source: "user" } }),
        JSON.stringify({
          timestamp: "2026-05-15T08:01:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { model: "gpt-5", total_token_usage: { input_tokens: 100 } }
          }
        }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }),
        JSON.stringify({
          type: "inter_agent_communication_metadata",
          payload: { trigger_turn: true }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:02:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { model: "gpt-5", total_token_usage: { input_tokens: 120 } }
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

    expect(result.records).toHaveLength(2);
    expect(snapshot.periods.today.total_tokens).toBe(120);
  });

  it("keeps every owned turn after the first confirmed subagent boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-token-meter-codex-jsonl-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "a-parent.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "parent" } }),
        JSON.stringify({
          timestamp: "2026-05-15T08:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { model: "gpt-5", total_token_usage: { input_tokens: 100 } }
          }
        })
      ].join("\n")
    );
    await writeFile(
      join(sessions, "b-subagent.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "subagent",
            forked_from_id: "parent",
            timestamp: "2026-05-15T08:00:30.000Z",
            thread_source: "subagent"
          }
        }),
        JSON.stringify({ type: "session_meta", payload: { id: "parent" } }),
        JSON.stringify({
          timestamp: "2026-05-15T08:01:00.000Z",
          type: "event_msg",
          payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100 } } }
        }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }),
        JSON.stringify({
          type: "inter_agent_communication_metadata",
          payload: { trigger_turn: true }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:02:00.000Z",
          type: "event_msg",
          payload: { type: "token_count", info: { total_token_usage: { input_tokens: 120 } } }
        }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }),
        JSON.stringify({
          type: "inter_agent_communication_metadata",
          payload: { trigger_turn: true }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:03:00.000Z",
          type: "event_msg",
          payload: { type: "token_count", info: { total_token_usage: { input_tokens: 150 } } }
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

    expect(result.records).toHaveLength(3);
    expect(snapshot.periods.today.total_tokens).toBe(150);
  });

  it("locally confirms a compact subagent boundary from total minus last usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-token-meter-codex-jsonl-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "a-parent.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "parent" } }),
        JSON.stringify({
          timestamp: "2026-05-15T08:00:00.000Z",
          type: "event_msg",
          payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100 } } }
        })
      ].join("\n")
    );
    await writeFile(
      join(sessions, "b-subagent.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "subagent",
            forked_from_id: "parent",
            timestamp: "2026-05-15T08:00:30.000Z",
            thread_source: "subagent"
          }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:01:00.000Z",
          type: "event_msg",
          payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100 } } }
        }),
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }),
        JSON.stringify({
          type: "inter_agent_communication_metadata",
          payload: { trigger_turn: true }
        }),
        JSON.stringify({
          timestamp: "2026-05-15T08:02:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: { input_tokens: 120 },
              last_token_usage: { input_tokens: 20 }
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

    expect(result.records).toHaveLength(2);
    expect(snapshot.periods.today.total_tokens).toBe(120);
  });

  it("uses an explicit subagent history boundary when no copied token row remains", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-token-meter-codex-jsonl-"));
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, "a-parent.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "parent" } }),
        JSON.stringify({
          timestamp: "2026-05-15T08:00:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { model: "gpt-5", total_token_usage: { input_tokens: 100 } }
          }
        })
      ].join("\n")
    );
    await writeFile(
      join(sessions, "b-subagent.jsonl"),
      [
        JSON.stringify({
          ordinal: 1,
          type: "session_meta",
          payload: {
            id: "subagent",
            forked_from_id: "parent",
            timestamp: "2026-05-15T08:00:30.000Z",
            thread_source: "subagent",
            subagent_history_start_ordinal: 5
          }
        }),
        JSON.stringify({
          ordinal: 5,
          timestamp: "2026-05-15T08:02:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              model: "gpt-5",
              total_token_usage: { input_tokens: 120 },
              last_token_usage: { input_tokens: 20 }
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

    expect(result.records).toHaveLength(2);
    expect(snapshot.periods.today.total_tokens).toBe(120);
  });

});
