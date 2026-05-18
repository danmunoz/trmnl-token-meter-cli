import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteCredential, loadConfig, loadCredential, saveCredential } from "../src/config.js";

describe("collector config", () => {
  it("loads platform paths and custom codex home from env", () => {
    const config = loadConfig({
      CODEX_HOME: "/tmp/codex-custom",
      TRMNL_TOKEN_METER_API_BASE_URL: "https://api.example.test/",
      TRMNL_TOKEN_METER_CONFIG_DIR: "/tmp/config",
      TRMNL_TOKEN_METER_CACHE_DIR: "/tmp/cache"
    });

    expect(config.apiBaseUrl).toBe("https://api.example.test");
    expect(config.codexHome).toBe("/tmp/codex-custom");
    expect(config.codexHomeKind).toBe("custom");
    expect(config.credentialPath).toBe("/tmp/config/credentials.json");
    expect(config.serviceDir).toBe("/tmp/config/service-runner");
    expect(config.serviceMetadataPath).toBe("/tmp/config/service.json");
    expect(config.serviceStatePath).toBe("/tmp/config/sync-state.json");
    expect(config.updateCheckPath).toBe("/tmp/config/update-check.json");
  });

  it("persists credentials with the expected fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collector-config-"));
    const path = join(dir, "credentials.json");
    await saveCredential(path, {
      collector_token: "secret-token",
      api_base_url: "https://api.example.test",
      machine_id: "mach_1",
      machine_label: "Laptop",
      upload_interval_minutes: 15
    });

    await expect(loadCredential(path)).resolves.toMatchObject({ machine_id: "mach_1" });
    await expect(readFile(path, "utf8")).resolves.toContain("collector_token");
    await deleteCredential(path);
    await expect(loadCredential(path)).resolves.toBeNull();
  });
});
