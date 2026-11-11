import { randomUUID } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { readClaudeProjectSource } from "../src/cost-sources/claude-projects.js";
import { claudeProjectRoots } from "../src/cost-sources/claude-roots.js";

const makeTempRoot = async () => {
  const root = join(tmpdir(), `trmnl-token-meter-claude-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
};

const writeJsonl = async (path: string, rows: unknown[]) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
};

type Row = {
  messageId?: string;
  requestId?: string;
  request_id?: string;
  sessionId?: string;
  timestamp?: string;
  usage?: Record<string, unknown>;
  stopReason?: string | null;
  extra?: Record<string, unknown>;
};

const assistant = (row: Row) => ({
  type: "assistant",
  timestamp: row.timestamp ?? "2026-11-10T10:00:00.000Z",
  ...(row.sessionId ? { sessionId: row.sessionId } : {}),
  ...(row.requestId ? { requestId: row.requestId } : {}),
  ...(row.request_id ? { request_id: row.request_id } : {}),
  ...row.extra,
  message: {
    ...(row.messageId ? { id: row.messageId } : {}),
    model: "claude-sonnet-5",
    ...(row.stopReason === undefined ? {} : { stop_reason: row.stopReason }),
    usage: row.usage ?? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  }
});

const scan = async (root: string) =>
  readClaudeProjectSource(loadConfig({ TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: root }));

const totals = (records: Awaited<ReturnType<typeof scan>>["records"]) =>
  records.reduce(
    (sum, record) => ({ input: sum.input + record.input_tokens, output: sum.output + record.output_tokens }),
    { input: 0, output: 0 }
  );

describe("Claude project counting (CodexBar 0.84.0 parity)", () => {
  it("dedupes repeated snapshots without a request id by session and message", async () => {
    const root = await makeTempRoot();
    await writeJsonl(join(root, "projects", "p", "proxy.jsonl"), [
      assistant({ messageId: "msg_1", sessionId: "s1", usage: { input_tokens: 10, output_tokens: 1 } }),
      assistant({ messageId: "msg_1", sessionId: "s1", usage: { input_tokens: 10, output_tokens: 40 } })
    ]);

    const result = await scan(root);
    expect(result.records).toHaveLength(1);
    expect(totals(result.records)).toEqual({ input: 10, output: 40 });
  });

  it("does not invent a session key when the row carries no session id", async () => {
    const root = await makeTempRoot();
    await writeJsonl(join(root, "projects", "p", "nosession.jsonl"), [
      assistant({ messageId: "msg_1", usage: { input_tokens: 10, output_tokens: 1 } }),
      assistant({ messageId: "msg_1", usage: { input_tokens: 10, output_tokens: 2 } })
    ]);

    expect((await scan(root)).records).toHaveLength(2);
  });

  it("treats request_id and requestId as the same request across files", async () => {
    const root = await makeTempRoot();
    await writeJsonl(join(root, "projects", "p", "transcript.jsonl"), [
      assistant({ messageId: "msg_1", requestId: "req_1", sessionId: "s1" })
    ]);
    await writeJsonl(join(root, "projects", "p", "audit.jsonl"), [
      assistant({ messageId: "msg_1", request_id: "req_1", sessionId: "s1" })
    ]);

    expect((await scan(root)).records).toHaveLength(1);
  });

  it("drops a proxy's incomplete estimate and keeps the complete row", async () => {
    const root = await makeTempRoot();
    const incomplete = { input_tokens: 5000, output_tokens: 0 };
    await writeJsonl(join(root, "projects", "p", "stream.jsonl"), [
      assistant({ messageId: "m1", requestId: "r1", stopReason: null, usage: incomplete }),
      assistant({
        messageId: "m1",
        requestId: "r1",
        stopReason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 30, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 }
      }),
      // A late incomplete snapshot never displaces the complete row.
      assistant({ messageId: "m1", requestId: "r1", stopReason: null, usage: incomplete }),
      // An unkeyed incomplete row adds nothing either.
      assistant({ stopReason: null, usage: incomplete })
    ]);

    const result = await scan(root);
    expect(result.records).toHaveLength(1);
    expect(totals(result.records)).toEqual({ input: 12, output: 30 });
  });

  it("only treats an explicit null stop_reason without cache lanes as incomplete", async () => {
    const root = await makeTempRoot();
    await writeJsonl(join(root, "projects", "p", "legacy.jsonl"), [
      // Missing stop_reason is legacy usage, not a proxy estimate.
      assistant({ messageId: "a", requestId: "a", usage: { input_tokens: 7, output_tokens: 0 } }),
      // Cache lanes present means the provider reported real usage.
      assistant({
        messageId: "b",
        requestId: "b",
        stopReason: null,
        usage: { input_tokens: 7, output_tokens: 0, cache_read_input_tokens: 0 }
      })
    ]);

    expect(totals((await scan(root)).records)).toEqual({ input: 14, output: 0 });
  });

  it("prefers a complete row from another file over an incomplete parent row", async () => {
    const root = await makeTempRoot();
    await writeJsonl(join(root, "projects", "a", "parent.jsonl"), [
      assistant({ messageId: "m1", requestId: "r1", stopReason: null, usage: { input_tokens: 900, output_tokens: 0 } })
    ]);
    await writeJsonl(join(root, "projects", "a", "subagents", "child.jsonl"), [
      assistant({ messageId: "m1", requestId: "r1", usage: { input_tokens: 3, output_tokens: 9 } })
    ]);

    expect(totals((await scan(root)).records)).toEqual({ input: 3, output: 9 });
  });

  it("keeps rows whose content mentions Vertex but excludes Vertex-routed rows", async () => {
    const root = await makeTempRoot();
    const mentionsVertex = assistant({ messageId: "m1", requestId: "r1" });
    (mentionsVertex.message as Record<string, unknown>).content = [
      { type: "text", text: "Deploying to Vertex AI next." }
    ];
    await writeJsonl(join(root, "projects", "p", "vertex.jsonl"), [
      mentionsVertex,
      assistant({ messageId: "m2", requestId: "r2", extra: { metadata: { api_provider: "vertex" } } }),
      assistant({ messageId: "msg_vrtx_3", requestId: "r3" })
    ]);

    const result = await scan(root);
    expect(result.records.map((record) => record.dedupe_key)).toEqual(["claude:m1:r1"]);
  });

  it("reads symlinked transcripts and uppercase extensions", async () => {
    const root = await makeTempRoot();
    const outside = await makeTempRoot();
    await writeJsonl(join(outside, "shared.jsonl"), [assistant({ messageId: "m1", requestId: "r1" })]);
    await mkdir(join(root, "projects", "p"), { recursive: true });
    await symlink(join(outside, "shared.jsonl"), join(root, "projects", "p", "linked.jsonl"));
    await writeJsonl(join(root, "projects", "p", "UPPER.JSONL"), [assistant({ messageId: "m2", requestId: "r2" })]);

    expect((await scan(root)).records).toHaveLength(2);
  });
});

describe("Claude transcript roots", () => {
  const defaults = () => loadConfig({ TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: "" });

  it("finds Claude Desktop homes, Cowork audit logs, and claude-swap profiles", async () => {
    const home = await makeTempRoot();
    const desktop = join(home, "Library", "Application Support", "Claude");
    const sessionHome = join(desktop, "claude-code-sessions", "org", "session-1");
    await mkdir(join(sessionHome, ".claude", "projects"), { recursive: true });
    const cowork = join(desktop, "local-agent-mode-sessions", "org", "task-1");
    await writeJsonl(join(cowork, "audit.jsonl"), []);
    await mkdir(join(desktop, "claude-code-sessions", "node_modules", "x", ".claude", "projects"), {
      recursive: true
    });
    await mkdir(join(home, ".claude-swap-backup", "sessions", "1-work", "projects"), { recursive: true });
    await mkdir(join(home, ".claude-swap-backup", "sessions", "0-invalid", "projects"), { recursive: true });
    await mkdir(join(home, ".claude-swap-backup", "sessions", "notes", "projects"), { recursive: true });

    const roots = await claudeProjectRoots(defaults(), {}, home);
    expect(roots).toEqual([
      join(home, ".config", "claude", "projects"),
      join(home, ".claude", "projects"),
      // Breadth-first: both sit at depth 2, and Cowork's session root is queued first.
      join(cowork, "audit.jsonl"),
      join(sessionHome, ".claude", "projects"),
      join(home, ".claude-swap-backup", "sessions", "1-work", "projects")
    ]);
  });

  it("uses only an explicitly configured root", async () => {
    const home = await makeTempRoot();
    await mkdir(join(home, ".claude-swap-backup", "sessions", "1-work", "projects"), { recursive: true });
    const config = loadConfig({ TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: join(home, "custom") });

    expect(await claudeProjectRoots(config, {}, home)).toEqual([join(home, "custom", "projects")]);
  });

  it("collapses roots that resolve to the same directory", async () => {
    const home = await makeTempRoot();
    await mkdir(join(home, ".claude", "projects"), { recursive: true });
    await mkdir(join(home, ".config", "claude"), { recursive: true });
    await symlink(join(home, ".claude", "projects"), join(home, ".config", "claude", "projects"));

    expect(await claudeProjectRoots(defaults(), {}, home)).toEqual([join(home, ".config", "claude", "projects")]);
  });

  it("scans a Cowork audit log given as a file root", async () => {
    const root = await makeTempRoot();
    const audit = join(root, "audit.jsonl");
    await writeJsonl(audit, [assistant({ messageId: "m1", request_id: "r1", sessionId: "s1" })]);
    const config = { ...loadConfig({}), claudeProjectsRoots: [audit] };

    const result = await readClaudeProjectSource(config);
    expect(result.records.map((record) => record.dedupe_key)).toEqual(["claude:m1:r1"]);
  });
});
