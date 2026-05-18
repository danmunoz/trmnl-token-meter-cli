import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

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
      TRMNL_TOKEN_METER_DISABLE_UPDATE_CHECK: "1"
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
    expect(stdout).not.toContain("CANARY_PROMPT_DO_NOT_UPLOAD");
    expect(stderr).toBe("");
  });

  it("pairs and persists credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach_cli",
          upload_interval_minutes: 15
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
            upload_interval_minutes: 15
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

    expect(stdout).toContain("Server: revoked");
    expect(stdout).toContain("trmnl-token-meter add");
  });

  it("treats already-revoked server credentials as local revoke success", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            collector_token: "secret-token",
            api_base_url: "https://api.example.test",
            machine_id: "mach_cli",
            upload_interval_minutes: 15
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
