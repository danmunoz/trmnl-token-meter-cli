import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { probeProviderStatus } from "../src/source-availability.js";

const makeTempRoot = () => mkdtemp(join(tmpdir(), "source-availability-"));

describe("provider availability probes", () => {
  it("reports a readable Claude projects root as available without requiring transcript files", async () => {
    const claudeConfigRoot = await makeTempRoot();
    await mkdir(join(claudeConfigRoot, "projects"), { recursive: true });

    const status = await probeProviderStatus(
      loadConfig({ TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR: claudeConfigRoot }),
      "claude"
    );

    expect(status).toEqual({ provider: "claude", status: "available" });
  });
});
