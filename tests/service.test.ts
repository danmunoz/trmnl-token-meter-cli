import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  isSyncDue,
  installStableRunner,
  refreshInstalledRunner,
  saveSyncState,
  serviceStatus,
  type ServiceMetadata
} from "../src/service.js";
import { COLLECTOR_VERSION } from "../src/types.js";

describe("background service support", () => {
  it("copies the npx runtime into a stable service runner directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-service-"));
    const source = join(root, "node_modules", "trmnl-token-meter", "dist");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "cli.js"), "console.log('runner')\n");
    await mkdir(join(source, "node_modules", "ignored-package"), { recursive: true });
    await writeFile(join(source, "node_modules", "ignored-package", "index.js"), "ignored\n");
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache")
    });

    const runner = await installStableRunner(config, source);

    expect(runner).toBe(join(config.serviceDir, "dist", "cli.js"));
    await expect(readFile(runner, "utf8")).resolves.toContain("runner");
    await expect(
      readFile(join(config.serviceDir, "dist", "node_modules", "ignored-package", "index.js"), "utf8")
    ).rejects.toThrow();
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
    await writeFile(
      join(source, "cli.js"),
      "if (process.argv.includes('--version')) process.stdout.write('0.1.1-test\\n'); else console.log('runner');\n"
    );
    const runner = await installStableRunner(config, source);
    const metadata: ServiceMetadata = {
      installed_at: "2026-05-15T12:00:00.000Z",
      method: "launchd",
      runner,
      interval_minutes: 60
    };
    await writeFile(config.serviceMetadataPath, `${JSON.stringify(metadata)}\n`);
    await saveSyncState(config, { last_status: "success" });

    await expect(serviceStatus(config)).resolves.toMatchObject({
      method: "launchd",
      runner,
      runner_version: "0.1.1-test",
      current_version: COLLECTOR_VERSION,
      interval_minutes: 60,
      last_status: "success"
    });
  });

  it("refreshes an installed runner from the current CLI runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-service-refresh-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache")
    });
    const previousSource = join(root, "dist-previous");
    const currentSource = join(root, "dist-current");
    await mkdir(previousSource, { recursive: true });
    await mkdir(currentSource, { recursive: true });
    await writeFile(join(previousSource, "cli.js"), "console.log('old runner')\n");
    await writeFile(join(currentSource, "cli.js"), "console.log('new runner')\n");

    const runner = await installStableRunner(config, previousSource);
    const metadata: ServiceMetadata = {
      installed_at: "2026-05-15T12:00:00.000Z",
      method: "launchd",
      runner,
      interval_minutes: 15
    };
    await writeFile(config.serviceMetadataPath, `${JSON.stringify(metadata)}\n`);

    await expect(refreshInstalledRunner(config, { sourceDir: currentSource })).resolves.toBe(true);
    await expect(readFile(runner, "utf8")).resolves.toContain("new runner");
    await expect(readFile(config.serviceMetadataPath, "utf8")).resolves.toContain(COLLECTOR_VERSION);
  });

  it("skips runner refresh when already running from the installed copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-service-refresh-skip-"));
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
      interval_minutes: 60,
      runner_version: COLLECTOR_VERSION
    };
    await writeFile(config.serviceMetadataPath, `${JSON.stringify(metadata)}\n`);

    await expect(refreshInstalledRunner(config, { sourceDir: join(config.serviceDir, "dist") })).resolves.toBe(
      false
    );
    await expect(readFile(runner, "utf8")).resolves.toContain("runner");
  });

  it("treats cron sync as due only after the configured interval", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-service-due-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache")
    });

    await expect(isSyncDue(config, 15, new Date("2026-05-18T12:00:00.000Z"))).resolves.toBe(true);
    await saveSyncState(config, {
      last_status: "success",
      last_sync_at: "2026-05-18T12:00:00.000Z"
    });
    await expect(isSyncDue(config, 15, new Date("2026-05-18T12:10:00.000Z"))).resolves.toBe(false);
    await expect(isSyncDue(config, 15, new Date("2026-05-18T12:16:00.000Z"))).resolves.toBe(true);
  });
});
