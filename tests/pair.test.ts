import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { saveCredential } from "../src/config.js";

describe("pair command", () => {
  const originalEnv = { ...process.env };
  let stdout = "";
  let configDir = "";

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "collector-pair-"));
    configDir = join(dir, "config");
    process.env = {
      ...originalEnv,
      TRMNL_TOKEN_METER_CONFIG_DIR: configDir,
      TRMNL_TOKEN_METER_CACHE_DIR: join(dir, "cache")
    };
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdout += chunk.toString();
      return true;
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("exchanges a pairing code and persists the collector credential", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          collector_token: "collector-secret",
          api_base_url: "https://api.example.test",
          machine_id: "mach_pair",
          upload_interval_minutes: 60
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await main([
      "pair",
      "--code",
      "ABCD-1234",
      "--machine-label",
      "Pair Test",
      "--api-base-url",
      "https://api.example.test"
    ]);

    const credential = JSON.parse(
      await readFile(join(configDir, "credentials.json"), "utf8")
    ) as Record<string, unknown>;
    expect(stdout).toContain("Paired mach_pair");
    expect(credential.collector_token).toBe("collector-secret");
    expect(credential.machine_label).toBe("Pair Test");
  });

  it("does not replace an existing meter without explicit consent", async () => {
    await saveCredential(join(configDir, "credentials.json"), {
      collector_token: "collector-secret",
      api_base_url: "https://api.example.test",
      machine_id: "mach_existing",
      machine_label: "Existing",
      upload_interval_minutes: 60
    });
    const fetchMock = vi.spyOn(globalThis, "fetch");

    await expect(main(["pair", "--code", "WXYZ-1234"])).rejects.toThrow("already paired");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
