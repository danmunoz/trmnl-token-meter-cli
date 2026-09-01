import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  isSyncDue,
  installStableRunner,
  envForService,
  launchdHealthFromReport,
  renderLaunchdPlist,
  refreshInstalledRunner,
  saveSyncState,
  serviceStatus,
  stableLauncherNodePath,
  type ServiceMetadata
} from "../src/service.js";
import { COLLECTOR_VERSION } from "../src/types.js";

async function writeRunner(path: string, body = "console.log('runner');\n", version = COLLECTOR_VERSION): Promise<void> {
  await writeFile(
    join(path, "cli.js"),
    `if (process.argv.includes('--version')) process.stdout.write('${version}\\n');\n${body}`
  );
}

describe("background service support", () => {
  it("copies the npx runtime into a stable service runner directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-service-"));
    const source = join(root, "node_modules", "trmnl-token-meter", "dist");
    await mkdir(source, { recursive: true });
    await writeRunner(source);
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
      `"type": "module"`
    );
    await expect(readFile(join(config.serviceDir, "package.json"), "utf8")).resolves.toContain(
      `"version": "${COLLECTOR_VERSION}"`
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
    await writeRunner(source);
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
      runner_version: COLLECTOR_VERSION,
      current_version: COLLECTOR_VERSION,
      interval_minutes: 60,
      last_status: "success"
    });
  });

  it("reports the installed runner version from the service package metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-service-package-version-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache")
    });
    const source = join(root, "dist-source");
    await mkdir(source, { recursive: true });
    await writeFile(
      join(source, "cli.js"),
      [
        "import { createRequire } from 'node:module';",
        "const require = createRequire(import.meta.url);",
        "const packageJson = require('../package.json');",
        "if (process.argv.includes('--version')) {",
        "  process.stdout.write(`${String(packageJson.version ?? '0.0.0-development')}\\n`);",
        "} else {",
        "  console.log('runner');",
        "}"
      ].join("\n")
    );
    const runner = await installStableRunner(config, source);
    const metadata: ServiceMetadata = {
      installed_at: "2026-05-15T12:00:00.000Z",
      method: "launchd",
      runner,
      interval_minutes: 60
    };
    await writeFile(config.serviceMetadataPath, `${JSON.stringify(metadata)}\n`);

    await expect(serviceStatus(config)).resolves.toMatchObject({
      runner_version: COLLECTOR_VERSION,
      current_version: COLLECTOR_VERSION
    });
  });

  it("includes enabled providers in service environment", () => {
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: "/tmp/config",
      TRMNL_TOKEN_METER_CACHE_DIR: "/tmp/cache"
    });
    const env = envForService(config, {
      enabled_providers: ["codex", "opencode", "claude"]
    });
    expect(env.TRMNL_TOKEN_METER_ENABLED_PROVIDERS).toBe("codex,opencode,claude");
  });

  it("falls back to configured providers when no credential providers are passed", () => {
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: "/tmp/config",
      TRMNL_TOKEN_METER_CACHE_DIR: "/tmp/cache",
      TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,opencode"
    });
    const env = envForService(config);
    expect(env.TRMNL_TOKEN_METER_ENABLED_PROVIDERS).toBe("codex,opencode");
  });

  it("preserves explicit disable-all config providers for service env", () => {
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: "/tmp/config",
      TRMNL_TOKEN_METER_CACHE_DIR: "/tmp/cache",
      TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "none"
    });
    const env = envForService(config);
    expect(env.TRMNL_TOKEN_METER_ENABLED_PROVIDERS).toBe("none");
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
    await writeRunner(previousSource, "console.log('old runner');\n");
    await writeRunner(currentSource, "console.log('new runner');\n");

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
    await writeRunner(source);

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

  it("fails fast when the copied runner cannot resolve a runtime dependency", async () => {
    const root = await mkdtemp(join(tmpdir(), "trmnl-service-bad-runner-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: join(root, "config"),
      TRMNL_TOKEN_METER_CACHE_DIR: join(root, "cache")
    });
    const source = join(root, "dist-source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "cli.js"), "import 'missing-package';\n");

    await expect(installStableRunner(config, source)).rejects.toThrow(
      "Could not verify service runner installation"
    );
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

describe("stableLauncherNodePath", () => {
  const cellar = "/opt/homebrew/Cellar/node/25.8.0/bin/node";
  const brewSymlink = "/opt/homebrew/bin/node";

  it("prefers a stable launcher that resolves to the running node binary", () => {
    // Homebrew keeps /opt/homebrew/bin/node pointed at the current keg, so
    // embedding it survives a `brew upgrade node` that removes the old Cellar.
    const realpath = (path: string): string => {
      if (path === cellar || path === brewSymlink) return cellar;
      throw new Error(`ENOENT: ${path}`);
    };
    expect(
      stableLauncherNodePath({ execPath: cellar, candidates: [brewSymlink], realpath })
    ).toBe(brewSymlink);
  });

  it("ignores launchers that resolve to a different runtime", () => {
    const systemNode = "/usr/bin/node";
    const realpath = (path: string): string => {
      if (path === cellar) return cellar;
      if (path === systemNode) return "/usr/bin/node18"; // unrelated binary
      throw new Error(`ENOENT: ${path}`);
    };
    expect(
      stableLauncherNodePath({ execPath: cellar, candidates: [systemNode], realpath })
    ).toBe(cellar);
  });

  it("falls back to execPath when no stable launcher matches (e.g. nvm/fnm)", () => {
    const nvm = "/Users/dev/.nvm/versions/node/v26.4.0/bin/node";
    const realpath = (path: string): string => {
      if (path === nvm) return nvm;
      throw new Error(`ENOENT: ${path}`);
    };
    expect(
      stableLauncherNodePath({ execPath: nvm, candidates: [brewSymlink], realpath })
    ).toBe(nvm);
  });

  it("falls back to execPath when the running binary cannot be resolved", () => {
    const realpath = (path: string): string => {
      if (path === cellar) throw new Error("ENOENT");
      return path;
    };
    expect(
      stableLauncherNodePath({ execPath: cellar, candidates: [brewSymlink], realpath })
    ).toBe(cellar);
  });
});

describe("launchdHealthFromReport", () => {
  it("requires repair for legacy launch agents without recorded launcher metadata", () => {
    expect(launchdHealthFromReport("state = not running", { hasLauncher: false, launcherAvailable: false })).toBe(
      "repair_required"
    );
  });

  it("reports a dynamic-loader crash loop even when metadata predates the launcher check", () => {
    expect(
      launchdHealthFromReport("successive crashes = 289\nlast exit reason = OS_REASON_DYLD", {
        hasLauncher: false,
        launcherAvailable: false
      })
    ).toBe("crash_loop");
  });

  it("reports an unavailable recorded runtime", () => {
    expect(launchdHealthFromReport("state = not running", { hasLauncher: true, launcherAvailable: false })).toBe(
      "runtime_unavailable"
    );
  });
});

describe("renderLaunchdPlist", () => {
  it("does not launch a repaired service immediately unless explicitly requested", () => {
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: "/tmp/trmnl-token-meter-config",
      TRMNL_TOKEN_METER_CACHE_DIR: "/tmp/trmnl-token-meter-cache"
    });

    const deferred = renderLaunchdPlist(config, "/tmp/runner.js", 60, "/opt/homebrew/bin/node", false);
    const immediate = renderLaunchdPlist(config, "/tmp/runner.js", 60, "/opt/homebrew/bin/node", true);

    expect(deferred).not.toContain("<key>RunAtLoad</key>");
    expect(immediate).toContain("<key>RunAtLoad</key>");
  });
});
