import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { COLLECTOR_VERSION } from "../src/types.js";
import { isNewerVersion, updateNotice } from "../src/update-check.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };

describe("update check", () => {
  it("uses the package version as the collector version", () => {
    expect(COLLECTOR_VERSION).toBe(packageJson.version);
  });

  it("compares semantic versions", () => {
    expect(isNewerVersion("0.1.1", "0.1.0")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
    expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
    expect(isNewerVersion("0.0.9", "0.1.0")).toBe(false);
  });

  it("returns an update notice and writes a cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-update-check-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache")
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ version: "0.1.1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(
      updateNotice(config, {
        fetchImpl: fetchMock,
        currentVersion: "0.1.0",
        now: new Date("2026-05-18T12:00:00.000Z")
      })
    ).resolves.toContain("npm install -g trmnl-token-meter@latest");
    await expect(readFile(config.updateCheckPath, "utf8")).resolves.toContain("0.1.1");
  });

  it("uses a fresh cache instead of fetching", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-update-cache-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache")
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ version: "0.1.1" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await updateNotice(config, {
      fetchImpl: fetchMock,
      currentVersion: "0.1.0",
      now: new Date("2026-05-18T12:00:00.000Z")
    });
    await updateNotice(config, {
      fetchImpl: fetchMock,
      currentVersion: "0.1.0",
      now: new Date("2026-05-18T12:30:00.000Z")
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors opt-outs", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-update-optout-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache")
    });
    const fetchMock = vi.fn<typeof fetch>();

    await expect(
      updateNotice(config, {
        fetchImpl: fetchMock,
        env: { TRMNL_TOKEN_METER_DISABLE_UPDATE_CHECK: "1" },
        currentVersion: "0.1.0"
      })
    ).resolves.toBeNull();
    await expect(
      updateNotice(config, {
        args: ["--no-update-check"],
        fetchImpl: fetchMock,
        currentVersion: "0.1.0"
      })
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
