import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  installStableRunner,
  saveSyncState,
  serviceStatus,
  type ServiceMetadata
} from "../src/service.js";

describe("background service support", () => {
  it("copies the npx runtime into a stable service runner directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-service-"));
    const source = join(root, "dist-source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "cli.js"), "console.log('runner')\n");
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache")
    });

    const runner = await installStableRunner(config, source);

    expect(runner).toBe(join(config.serviceDir, "dist", "cli.js"));
    await expect(readFile(runner, "utf8")).resolves.toContain("runner");
    await expect(readFile(join(config.serviceDir, "package.json"), "utf8")).resolves.toContain(
      "\"type\":\"module\""
    );
  });

  it("reports local service metadata and last sync state", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-service-status-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache")
    });
    const source = join(root, "dist-source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "cli.js"), "console.log('runner')\n");
    const runner = await installStableRunner(config, source);
    const metadata: ServiceMetadata = {
      installed_at: "2026-05-15T12:00:00.000Z",
      method: "launchd",
      runner,
      interval_minutes: 15
    };
    await writeFile(config.serviceMetadataPath, `${JSON.stringify(metadata)}\n`);
    await saveSyncState(config, { last_status: "success" });

    await expect(serviceStatus(config)).resolves.toMatchObject({
      installed: true,
      method: "launchd",
      runner,
      interval_minutes: 15,
      last_status: "success"
    });
  });
});
