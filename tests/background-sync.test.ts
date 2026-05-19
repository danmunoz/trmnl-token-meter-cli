import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixtureRoot = new URL("./fixtures/codex-jsonl/default", import.meta.url).pathname;

describe("background sync entrypoint", () => {
  const originalEnv = { ...process.env };
  let configDir = "";
  let cacheDir = "";

  beforeEach(async () => {
    vi.resetModules();
    const dir = await mkdtemp(join(tmpdir(), "collector-background-sync-"));
    configDir = join(dir, "config");
    cacheDir = join(dir, "cache");
    process.env = {
      ...originalEnv,
      CODEX_HOME: fixtureRoot,
      TRMNL_TOKEN_METER_CONFIG_DIR: configDir,
      TRMNL_TOKEN_METER_CACHE_DIR: cacheDir,
      TRMNL_TOKEN_METER_API_BASE_URL: "https://api.example.test",
      TRMNL_TOKEN_METER_DISABLE_UPDATE_CHECK: "1"
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("runs sync without loading interactive prompt dependencies", async () => {
    vi.doMock("@clack/prompts", () => {
      throw new Error("interactive prompt dependency should not load during background sync");
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, upload_interval_minutes: 60 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "credentials.json"),
      `${JSON.stringify({
        collector_token: "secret-token",
        api_base_url: "https://api.example.test",
        machine_id: "mach_cli",
        machine_label: "CLI Machine",
        upload_interval_minutes: 60
      })}\n`
    );

    const { main } = await import("../src/cli.js");

    await expect(main(["sync", "--once"])).resolves.toBeUndefined();
  });
});
