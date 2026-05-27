import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteCredential,
  loadConfig,
  loadCredential,
  loadSourceNoticeState,
  saveCredential,
  saveSourceNoticeState
} from "../src/config.js";
import { parseProviders } from "../src/source-providers.js";

describe("collector config", () => {
  it("defaults to the hosted collector backend", () => {
    const config = loadConfig({});

    expect(config.apiBaseUrl).toBe("https://trmnl-token-meter-backend.trmnltkn.workers.dev");
  });

  it("loads platform paths and custom codex home from env", () => {
    const config = loadConfig({
      CODEX_HOME: "/tmp/codex-custom",
      TRMNL_TOKEN_METER_API_BASE_URL: "https://api.example.test/",
      TRMNL_TOKEN_METER_CONFIG_DIR: "/tmp/config",
      TRMNL_TOKEN_METER_CACHE_DIR: "/tmp/cache",
      TRMNL_TOKEN_METER_OPENCODE_DB: "/tmp/opencode/opencode.db",
      TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: "/tmp/claude-one,/tmp/claude-two/projects"
    });

    expect(config.apiBaseUrl).toBe("https://api.example.test");
    expect(config.codexHome).toBe("/tmp/codex-custom");
    expect(config.codexHomeKind).toBe("custom");
    expect(config.credentialPath).toBe("/tmp/config/credentials.json");
    expect(config.serviceDir).toBe("/tmp/config/service-runner");
    expect(config.serviceMetadataPath).toBe("/tmp/config/service.json");
    expect(config.serviceStatePath).toBe("/tmp/config/sync-state.json");
    expect(config.updateCheckPath).toBe("/tmp/config/update-check.json");
    expect(config.opencodeDbPath).toBe("/tmp/opencode/opencode.db");
      expect(config.claudeProjectsRoots).toEqual([
      "/tmp/claude-one/projects",
      "/tmp/claude-two/projects"
    ]);
  });

  it("defaults enabled providers to codex when env override is missing", () => {
    const config = loadConfig({});
    expect(config.enabledProviders).toEqual(["codex"]);
  });

  it("parses TRMNL_TOKEN_METER_ENABLED_PROVIDERS with dedupe and filtering", () => {
    const config = loadConfig({
      TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "codex,opencode,claude,unknown,opencode,codex"
    });
    expect(config.enabledProviders).toEqual(["codex", "opencode", "claude"]);
  });

  it("parses TRMNL_TOKEN_METER_ENABLED_PROVIDERS=none as explicit disable-all", () => {
    const config = loadConfig({
      TRMNL_TOKEN_METER_ENABLED_PROVIDERS: "none"
    });
    expect(config.enabledProviders).toEqual([]);
  });

  it("sanitizes persisted enabled_providers lists for unknown values", () => {
    expect(
      parseProviders(["codex", "unknown", "codex", "opencode", "", "claude", 42 as unknown], ["codex"])
    ).toEqual(["codex", "opencode", "claude"]);
  });

  it("persists credentials with the expected fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collector-config-"));
    const path = join(dir, "credentials.json");
    await saveCredential(path, {
      enabled_providers: ["codex", "opencode", "claude"],
      collector_token: "secret-token",
      api_base_url: "https://api.example.test",
      machine_id: "mach_1",
      machine_label: "Laptop",
      upload_interval_minutes: 60
    });

    await expect(loadCredential(path)).resolves.toMatchObject({ machine_id: "mach_1" });
    await expect(readFile(path, "utf8")).resolves.toContain("collector_token");
    await deleteCredential(path);
    await expect(loadCredential(path)).resolves.toBeNull();
  });

  it("defaults source notice state to codex only when no file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collector-config-source-notice-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: dir
    });
    await expect(loadSourceNoticeState(config)).resolves.toEqual({
      known_supported_providers: ["codex"]
    });
  });

  it("persists source-notice state updates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collector-config-source-notice-save-"));
    const config = loadConfig({
      TRMNL_TOKEN_METER_CONFIG_DIR: dir
    });
    await saveSourceNoticeState(config, { known_supported_providers: ["codex", "opencode", "claude"] });
    await expect(loadSourceNoticeState(config)).resolves.toEqual({
      known_supported_providers: ["codex", "opencode", "claude"]
    });
  });
});
