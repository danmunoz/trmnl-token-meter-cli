import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { scanLocalCostSources } from "../src/cost-scan.js";

const makeTempRoot = async () => {
  const root = join(tmpdir(), `trmnl-token-meter-ledger-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
};

const dayDir = (root: string) => join(root, "sessions", "2026", "11", "05");

const writeRollout = async (path: string, rows: unknown[]) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
};

const scan = async (root: string) =>
  scanLocalCostSources(
    loadConfig({
      CODEX_HOME: root,
      TRMNL_TOKEN_METER_OPENCODE_DB: join(root, "missing.db"),
      TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: join(root, "missing-claude"),
      TRMNL_TOKEN_METER_CODEXBAR: "off"
    })
  );

type Usage = [input: number, cached: number, output: number];
const usage = ([input, cached, output]: Usage) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  output_tokens: output,
  reasoning_output_tokens: 0,
  total_tokens: input + output
});

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 5, 12, 0, seconds)).toISOString();

const meta = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "session_meta",
  timestamp: at(0),
  payload: { id, session_id: `shared-${id}`, ...extra }
});
const taskStarted = (turn: string, seconds = 1) => ({
  type: "event_msg",
  timestamp: at(seconds),
  payload: { type: "task_started", turn_id: turn }
});
const turnContext = (turn: string, model: string, seconds = 1) => ({
  type: "turn_context",
  timestamp: at(seconds),
  payload: { turn_id: turn, model }
});
const tokenCount = (seconds: number, last: Usage, total: Usage) => ({
  type: "event_msg",
  timestamp: at(seconds),
  payload: { type: "token_count", info: { last_token_usage: usage(last), total_token_usage: usage(total) } }
});
const ledger = (
  thread: string,
  seconds: number,
  response: string,
  turn: string,
  request: Usage,
  threadTotal: Usage,
  sessionId = `shared-${thread}`
) => ({
  type: "token_usage_record",
  timestamp: at(seconds),
  payload: {
    thread_id: thread,
    session_id: sessionId,
    turn_id: turn,
    response_id: response,
    usage: usage(request),
    thread_token_usage: usage(threadTotal)
  }
});

const tokens = (records: Awaited<ReturnType<typeof scan>>["records"]) =>
  records.reduce((sum, record) => sum + record.input_tokens + record.output_tokens, 0);

describe("Codex request ledger (CodexBar 0.84.0 parity)", () => {
  it("counts each request once when token_count mirrors a ledger record", async () => {
    const root = await makeTempRoot();
    await writeRollout(join(dayDir(root), "rollout-a.jsonl"), [
      meta("thread-a"),
      taskStarted("turn-1"),
      turnContext("turn-1", "gpt-6.1-sol"),
      ledger("thread-a", 10, "resp-1", "turn-1", [1000, 100, 50], [1000, 100, 50]),
      tokenCount(11, [1000, 100, 50], [1000, 100, 50]),
      ledger("thread-a", 20, "resp-2", "turn-1", [2000, 900, 70], [3000, 1000, 120]),
      tokenCount(21, [2000, 900, 70], [3000, 1000, 120])
    ]);

    const result = await scan(root);
    expect(result.records).toHaveLength(2);
    expect(tokens(result.records)).toBe(1050 + 2070);
    expect(result.records.every((record) => record.model === "gpt-6.1-sol")).toBe(true);
  });

  it("counts requests that only the ledger recorded, and ignores replays and copied parent records", async () => {
    const root = await makeTempRoot();
    await writeRollout(join(dayDir(root), "rollout-a.jsonl"), [
      meta("thread-a"),
      taskStarted("turn-1"),
      turnContext("turn-1", "gpt-6-luna"),
      // Copied from a parent thread: not this rollout's usage.
      ledger("parent-thread", 5, "resp-parent", "turn-0", [9999, 0, 9999], [9999, 0, 9999], "shared-thread-a"),
      ledger("thread-a", 10, "resp-1", "turn-1", [400, 0, 40], [400, 0, 40]),
      // The same response written twice counts once.
      ledger("thread-a", 11, "resp-1", "turn-1", [400, 0, 40], [400, 0, 40])
    ]);

    const result = await scan(root);
    expect(tokens(result.records)).toBe(440);
  });

  it("pairs a token_count written well after its record when both counters advanced by exactly it", async () => {
    const root = await makeTempRoot();
    await writeRollout(join(dayDir(root), "rollout-a.jsonl"), [
      meta("thread-a"),
      taskStarted("turn-1"),
      turnContext("turn-1", "gpt-6.1-sol"),
      ledger("thread-a", 10, "resp-1", "turn-1", [1000, 0, 10], [5000, 0, 100]),
      tokenCount(11, [1000, 0, 10], [4000, 0, 90]),
      // Counters drifted apart after compaction; this mirror lands 8 seconds late.
      ledger("thread-a", 20, "resp-2", "turn-1", [1200, 0, 20], [6200, 0, 120]),
      tokenCount(28, [1200, 0, 20], [5200, 0, 110])
    ]);

    const result = await scan(root);
    expect(result.records).toHaveLength(2);
    expect(tokens(result.records)).toBe(1010 + 1220);
  });

  it("keeps the legacy count for a token_count with no ledger record", async () => {
    const root = await makeTempRoot();
    await writeRollout(join(dayDir(root), "rollout-a.jsonl"), [
      meta("thread-a"),
      taskStarted("turn-1"),
      turnContext("turn-1", "gpt-5.5"),
      tokenCount(10, [300, 0, 30], [300, 0, 30])
    ]);

    expect(tokens((await scan(root)).records)).toBe(330);
  });

  it("counts every page of a thread Codex split across files", async () => {
    const root = await makeTempRoot();
    await writeRollout(join(dayDir(root), "rollout-a.jsonl"), [
      meta("thread-a"),
      taskStarted("turn-1"),
      turnContext("turn-1", "gpt-6.1-sol"),
      ledger("thread-a", 10, "resp-1", "turn-1", [1000, 0, 10], [1000, 0, 10]),
      tokenCount(11, [1000, 0, 10], [1000, 0, 10])
    ]);
    await writeRollout(join(dayDir(root), "rollout-a_page-2.jsonl"), [
      meta("thread-a", { history_base: { thread_id: "thread-a" } }),
      taskStarted("turn-2", 30),
      turnContext("turn-2", "gpt-6.1-sol", 30),
      ledger("thread-a", 40, "resp-2", "turn-2", [2000, 0, 20], [3000, 0, 30]),
      tokenCount(41, [2000, 0, 20], [3000, 0, 30])
    ]);

    const result = await scan(root);
    expect(tokens(result.records)).toBe(1010 + 2020);
  });

  it("keys sessions by the rollout's own thread id, not the shared session id", async () => {
    const root = await makeTempRoot();
    for (const thread of ["thread-a", "thread-b"]) {
      await writeRollout(join(dayDir(root), `rollout-${thread}.jsonl`), [
        { type: "session_meta", timestamp: at(0), payload: { id: thread, session_id: "shared-tree" } },
        taskStarted(`${thread}-turn`),
        turnContext(`${thread}-turn`, "gpt-5.5"),
        tokenCount(10, [500, 0, 5], [500, 0, 5])
      ]);
    }

    const result = await scan(root);
    expect(tokens(result.records)).toBe(1010);
  });

  it("prices turns run on the Fast tier as priority", async () => {
    const root = await makeTempRoot();
    const settings = (tier: string) => ({
      type: "event_msg",
      timestamp: at(0),
      payload: { type: "thread_settings_applied", thread_settings: { service_tier: tier } }
    });
    await writeRollout(join(dayDir(root), "rollout-a.jsonl"), [
      meta("thread-a"),
      settings("priority"),
      taskStarted("fast-turn", 1),
      turnContext("fast-turn", "gpt-6.1-sol", 1),
      ledger("thread-a", 10, "resp-1", "fast-turn", [100, 0, 10], [100, 0, 10]),
      settings("default"),
      taskStarted("standard-turn", 20),
      turnContext("standard-turn", "gpt-6.1-sol", 20),
      ledger("thread-a", 30, "resp-2", "standard-turn", [100, 0, 10], [200, 0, 20])
    ]);

    const tiers = (await scan(root)).records.map((record) => [record.turn_id, record.priority_tier]);
    expect(tiers).toEqual([
      ["fast-turn", "priority"],
      ["standard-turn", "base"]
    ]);
  });

  const zstd = (zlib as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync;
  it.skipIf(!zstd)("reads rollouts Codex compressed to .jsonl.zst, preferring a plain twin", async () => {
    const root = await makeTempRoot();
    const rows = (thread: string, size: number) =>
      [meta(thread), taskStarted("t"), turnContext("t", "gpt-5.5"), tokenCount(10, [size, 0, 0], [size, 0, 0])]
        .map((row) => JSON.stringify(row))
        .join("\n");
    await mkdir(dayDir(root), { recursive: true });
    await writeFile(join(dayDir(root), "rollout-cold.jsonl.zst"), zstd!(Buffer.from(rows("cold", 700))));
    // Both forms present: the plain file wins and the archive is not read twice.
    await writeFile(join(dayDir(root), "rollout-warm.jsonl"), rows("warm", 300));
    await writeFile(join(dayDir(root), "rollout-warm.jsonl.zst"), zstd!(Buffer.from(rows("warm", 300))));

    expect(tokens((await scan(root)).records)).toBe(1000);
  });
});
