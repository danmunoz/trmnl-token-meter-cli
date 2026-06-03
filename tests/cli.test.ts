import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { saveCredential } from "../src/config.js";

const fixtureRoot = new URL("./fixtures/codex-jsonl/default", import.meta.url).pathname;

describe("collector CLI", () => {
  let stdout = "";
  let stderr = "";
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00.000Z"));
    const dir = await mkdtemp(join(tmpdir(), "collector-cli-"));
    process.env = {
      ...originalEnv,
      CODEX_HOME: fixtureRoot,
      TRMNL_TOKEN_METER_CONFIG_DIR: join(dir, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(dir, "cache"),
      TRMNL_TOKEN_METER_API_BASE_URL: "https://api.example.test",
      TRMNL_TOKEN_METER_DISABLE_UPDATE_CHECK: "1",
      TRMNL_TOKEN_METER_OPENCODE_DB: join(dir, "missing-opencode.db"),
      TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: join(dir, "missing-claude")
    };
    stdout = "";
    stderr = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("collects a sanitized aggregate to stdout", async () => {
    await main(["collect"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.periods.today.total_tokens).toBe(215);
    expect(parsed.periods.last_14_days.total_tokens).toBe(250);
    expect(parsed.daily).toHaveLength(15);
    expect(stdout).not.toContain("CANARY_PROMPT_DO_NOT_UPLOAD");
    expect(stdout).not.toContain("input_tokens");
    expect(stdout).not.toContain("cached_input_tokens");
    expect(stdout).not.toContain("output_tokens");
    expect(stdout).not.toContain("cache_read_input_tokens");
    expect(stdout).not.toContain("cache_creation_input_tokens");
    expect(stdout).not.toContain("token_breakdown");
    expect(stderr).toBe("");
  });

  it("prints a privacy-first provider notice when new supported providers appear", async () => {
    const statePath = process.env.TRMNL_TOKEN_METER_CONFIG_DIR + "/source-state.json";
    await main(["status"]);
    expect(stderr).toContain("New local sources are supported: OpenCode, Claude.");
    expect(stderr).toContain("They are not collected until enabled in the TRMNL Token Meter web config.");
    expect(stderr).toContain(
      "Raw prompts, responses, commands, paths, OpenCode messages, and Claude transcripts stay on this machine."
    );
    const state = JSON.parse(await readFile(statePath, "utf8")) as { known_supported_providers: string[] };
    expect(state.known_supported_providers).toEqual(["codex", "opencode", "claude"]);

    stdout = "";
    stderr = "";
    await main(["status"]);
    expect(stderr).toBe("");
  });

  it("does not show provider notice or source-state changes on --help", async () => {
    await main(["--help"]);
    expect(stderr).toBe("");
    expect(stdout).toContain("TRMNL Token Meter");
    await expect(readFile(process.env.TRMNL_TOKEN_METER_CONFIG_DIR + "/source-state.json", "utf8")).rejects.toThrow();
  });

  it("does not show provider notice on --version", async () => {
    await main(["--version"]);
    expect(stdout).toMatch(/^[^\\s]+/);
    expect(stderr).toBe("");
    await expect(readFile(process.env.TRMNL_TOKEN_METER_CONFIG_DIR + "/source-state.json", "utf8")).rejects.toThrow();
  });

  it("pairs and persists credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach_cli",
          upload_interval_minutes: 60
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await main(["pair", "--code", "ABCD-1234", "--machine-label", "CLI Machine"]);
    expect(stdout).toContain("Paired mach_cli");
  });

  it("prints help for no-tty default execution", async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      await main([]);

      expect(stdout).toContain("TRMNL Token Meter");
      expect(stdout).toContain("trmnl-token-meter setup");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: original, configurable: true });
    }
  });

  it("shows revoked status without failing", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            collector_token: "secret-token",
            api_base_url: "https://api.example.test",
            machine_id: "mach_cli",
            upload_interval_minutes: 60
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "collector_revoked" }), {
          status: 403,
          headers: { "content-type": "application/json" }
        })
      );

    await main(["pair", "--code", "ABCD-1234", "--machine-label", "CLI Machine"]);
    stdout = "";

    await main(["status"]);

    expect(stdout).toContain("Server");
    expect(stdout).toContain("Server: revoked");
    expect(stdout).toContain("trmnl-token-meter add");
  });

  it("reconciles the locally stored upload interval from status responses", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            collector_token: "secret-token",
            api_base_url: "https://api.example.test",
            machine_id: "mach_cli",
            upload_interval_minutes: 60
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            plugin_status: "active",
            machine_status: "active",
            last_received_at: "2026-05-15T12:00:00.000Z",
            upload_interval_minutes: 240
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );

    await main(["pair", "--code", "ABCD-1234", "--machine-label", "CLI Machine"]);
    stdout = "";

    await main(["status"]);

    await expect(readFile(process.env.TRMNL_TOKEN_METER_CONFIG_DIR + "/credentials.json", "utf8")).resolves.toContain(
      '"upload_interval_minutes": 240'
    );
    expect(stdout).toContain("Configured upload interval: every 4 hours");
  });

  it("saves backend provider differences into credentials and uploads once more when providers are newly enabled", async () => {
    const configDir = process.env.TRMNL_TOKEN_METER_CONFIG_DIR;
    if (!configDir) throw new Error("TRMNL_TOKEN_METER_CONFIG_DIR must be set");
    const opencodeDb = join(configDir, "opencode.db");
    await mkdir(configDir, { recursive: true });
    const sqliteModule = (await import("node:sqlite")) as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean; open?: boolean }) => {
        exec(sql: string): void;
        prepare(sql: string): { run(...values: unknown[]): void };
        close(): void;
      };
    };
    const db = new sqliteModule.DatabaseSync(opencodeDb);
    try {
      db.exec(`
        create table if not exists session (
          id text primary key,
          time_created text,
          model text,
          tokens_input integer,
          tokens_cache_read integer,
          tokens_cache_write integer,
          tokens_output integer,
          tokens_reasoning integer,
          cost real
        )
      `);
    } finally {
      db.close();
    }
    process.env.TRMNL_TOKEN_METER_OPENCODE_DB = opencodeDb;
    await saveCredential(configDir + "/credentials.json", {
      collector_token: "secret-token",
      api_base_url: "https://api.example.test",
      machine_id: "mach_cli",
      machine_label: "CLI Machine",
      upload_interval_minutes: 60,
      enabled_providers: ["codex"]
    });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            enabled_providers: ["codex", "opencode"]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: true }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await main(["upload"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUpload = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body?.toString() ?? "{}") as {
      collector: { enabled_providers: string[]; provider_statuses: Array<{ provider: string }> };
    };
    const secondUpload = JSON.parse(fetchMock.mock.calls[1]?.[1]?.body?.toString() ?? "{}") as {
      collector: { enabled_providers: string[]; provider_statuses: Array<{ provider: string }> };
    };
    expect(firstUpload.collector.enabled_providers).toEqual(["codex"]);
    expect(firstUpload.collector.provider_statuses).toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: "opencode" })])
    );
    expect(secondUpload.collector.enabled_providers).toEqual(["codex", "opencode"]);
    const credential = JSON.parse(await readFile(configDir + "/credentials.json", "utf8")) as {
      enabled_providers: string[];
    };
    expect(credential.enabled_providers).toEqual(["codex", "opencode"]);
  });

  it("does not overwrite local enabled providers on invalid-only backend provider payloads", async () => {
    const configDir = process.env.TRMNL_TOKEN_METER_CONFIG_DIR;
    if (!configDir) throw new Error("TRMNL_TOKEN_METER_CONFIG_DIR must be set");
    await saveCredential(configDir + "/credentials.json", {
      collector_token: "secret-token",
      api_base_url: "https://api.example.test",
      machine_id: "mach_cli",
      machine_label: "CLI Machine",
      upload_interval_minutes: 60,
      enabled_providers: ["codex"]
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          enabled_providers: ["future"]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await main(["upload"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const credential = JSON.parse(await readFile(configDir + "/credentials.json", "utf8")) as {
      enabled_providers: string[];
    };
    expect(credential.enabled_providers).toEqual(["codex"]);
  });

  it("uses persisted empty provider consent for collect and disables all providers", async () => {
    const configDir = process.env.TRMNL_TOKEN_METER_CONFIG_DIR;
    if (!configDir) throw new Error("TRMNL_TOKEN_METER_CONFIG_DIR must be set");
    await saveCredential(configDir + "/credentials.json", {
      collector_token: "secret-token",
      api_base_url: "https://api.example.test",
      machine_id: "mach_cli",
      machine_label: "CLI Machine",
      upload_interval_minutes: 60,
      enabled_providers: []
    });

    stdout = "";
    await main(["collect"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.collector.enabled_providers).toEqual([]);
    expect(parsed.periods.today.total_tokens).toBe(0);
  });

  it("persists and reuses empty backend provider list when server disables all providers", async () => {
    const configDir = process.env.TRMNL_TOKEN_METER_CONFIG_DIR;
    if (!configDir) throw new Error("TRMNL_TOKEN_METER_CONFIG_DIR must be set");
    await saveCredential(configDir + "/credentials.json", {
      collector_token: "secret-token",
      api_base_url: "https://api.example.test",
      machine_id: "mach_cli",
      machine_label: "CLI Machine",
      upload_interval_minutes: 60,
      enabled_providers: ["codex"]
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          enabled_providers: []
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);

    await main(["upload"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const credential = JSON.parse(await readFile(configDir + "/credentials.json", "utf8")) as {
      enabled_providers: string[];
    };
    expect(credential.enabled_providers).toEqual([]);

    stdout = "";
    await main(["collect"]);
    const parsed = JSON.parse(stdout);
    expect(parsed.collector.enabled_providers).toEqual([]);
    expect(parsed.periods.today.total_tokens).toBe(0);
  });

  it("treats already-revoked server credentials as local revoke success", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            collector_token: "secret-token",
            api_base_url: "https://api.example.test",
            machine_id: "mach_cli",
            upload_interval_minutes: 60
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "collector_revoked" }), {
          status: 403,
          headers: { "content-type": "application/json" }
        })
      );

    await main(["pair", "--code", "ABCD-1234", "--machine-label", "CLI Machine"]);
    stdout = "";

    await main(["revoke", "--yes"]);

    expect(stdout).toContain("already revoked");
    await expect(readFile(process.env.TRMNL_TOKEN_METER_CONFIG_DIR + "/credentials.json", "utf8")).rejects.toThrow();
  });
});
