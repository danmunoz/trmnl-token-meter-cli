import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { loadConfig } from "../src/config.js";
import { scanLocalCostSources } from "../src/cost-scan.js";
import { serializeAggregateForUpload } from "../src/upload.js";

const fixtureRoot = new URL("./fixtures/codex-jsonl/default", import.meta.url).pathname;
const writeJsonl = async (path: string, lines: string[]) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`);
};

const createOpenCodeDb = async (path: string) => {
  const sqlite = (await import("node:sqlite")) as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...values: unknown[]): void };
      close(): void;
    };
  };
  const db = new sqlite.DatabaseSync(path);
  db.exec(`
    create table message (
      id text primary key,
      session_id text,
      time_created integer,
      time_updated integer,
      data text
    )
  `);
  const created = Date.parse("2026-05-15T11:00:00.000Z");
  // The message `data` blob mixes real usage numbers with raw local context that
  // must never be extracted into a record or uploaded.
  const data = {
    role: "assistant",
    modelID: "openai/gpt-5",
    providerID: "openai",
    title: "CANARY_TITLE_DO_NOT_UPLOAD",
    directory: "CANARY_DIRECTORY_DO_NOT_UPLOAD",
    path: "CANARY_PATH_DO_NOT_UPLOAD",
    project: "CANARY_PROJECT_DO_NOT_UPLOAD",
    account: "CANARY_ACCOUNT_DO_NOT_UPLOAD",
    summary: "CANARY_MESSAGE_DO_NOT_UPLOAD",
    text: "CANARY_PART_DO_NOT_UPLOAD",
    time: { created },
    cost: 0.1,
    tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 10 } }
  };
  db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)`
  ).run("opencode-message-canary", "session-1", created, created, JSON.stringify(data));
  db.close();
};

const canaries = [
  "CANARY_PROMPT_DO_NOT_UPLOAD",
  "CANARY_RESPONSE_DO_NOT_UPLOAD",
  "CANARY_TOOL_OUTPUT_DO_NOT_UPLOAD",
  "/Users/danielmunoz/Repos/private-project",
  "cat /Users/danielmunoz/.ssh/id_rsa",
  "CANARY_TITLE_DO_NOT_UPLOAD",
  "CANARY_DIRECTORY_DO_NOT_UPLOAD",
  "CANARY_PATH_DO_NOT_UPLOAD",
  "CANARY_PROJECT_DO_NOT_UPLOAD",
  "CANARY_ACCOUNT_DO_NOT_UPLOAD",
  "CANARY_MESSAGE_DO_NOT_UPLOAD",
  "CANARY_PART_DO_NOT_UPLOAD"
];

describe("privacy canaries", () => {
  it("keeps raw Codex content out of production upload serialization", async () => {
    const dir = await mkdtemp(join(tmpdir(), "privacy-canaries-"));
    const opencodeDb = join(dir, "opencode.db");
    const claudeRoot = join(dir, "claude");
    await createOpenCodeDb(opencodeDb);
    await writeJsonl(join(claudeRoot, "projects", "project-a", "stream.jsonl"), [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-05-15T11:00:00.000Z",
        sessionId: "claude-session-1",
        requestId: "req_stream",
        isSidechain: false,
        message: {
          id: "msg_stream",
          model: "claude-sonnet-4-5-20250929",
          usage: { input_tokens: 50, cache_creation_input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 19 },
          content: "CANARY_RESPONSE_DO_NOT_UPLOAD"
        }
      })
    ]);
    const config = loadConfig({
      CODEX_HOME: fixtureRoot,
      TRMNL_TOKEN_METER_OPENCODE_DB: opencodeDb,
      TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: claudeRoot,
      TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,opencode",
      TRMNL_TOKEN_METER_CODEXBAR: "off"
    });
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
    expect(serialized).not.toContain("input_tokens");
    expect(serialized).not.toContain("cached_input_tokens");
    expect(serialized).not.toContain("output_tokens");
    expect(serialized).not.toContain("cache_read_input_tokens");
    expect(serialized).not.toContain("cache_creation_input_tokens");
    expect(serialized).not.toContain("token_breakdown");
    expect(JSON.parse(serialized)).toEqual(snapshot);
  });
});
