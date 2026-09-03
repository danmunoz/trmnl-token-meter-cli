import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexBarDailyLanes,
  codexBarProviderArgument,
  findCodexBarBinary,
  parseCodexBarCostPayload,
  parseCodexBarVersion,
  type CodexBarDaily
} from "../src/cost-sources/codexbar-cli.js";

const daily = (overrides: Partial<CodexBarDaily> = {}): CodexBarDaily => ({
  date: "2026-08-31",
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  totalCost: null,
  modelBreakdowns: [],
  ...overrides
});

const writeExecutable = async (path: string): Promise<string> => {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
};

describe("codexbar cost payload parsing", () => {
  it("reads the documented cost fields", () => {
    const parsed = parseCodexBarCostPayload([
      {
        provider: "Codex",
        source: "local",
        provenance: "listPriceEstimate",
        coverage: { priced: 2, estimated: 0, unpriced: 1, unmetered: 0 },
        daily: [
          {
            date: "2026-08-31",
            inputTokens: 32_148_427,
            cacheReadTokens: 31_412_352,
            outputTokens: 82_597,
            totalTokens: 32_231_024,
            totalCost: 8.7457844,
            modelBreakdowns: [
              { modelName: "gpt-5.6-terra", cost: 8.7457844, totalTokens: 32_231_024 }
            ]
          }
        ]
      }
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.provider).toBe("codex");
    expect(parsed[0]?.coverage).toEqual({ priced: 2, estimated: 0, unpriced: 1, unmetered: 0 });
    expect(parsed[0]?.daily[0]?.modelBreakdowns[0]?.modelName).toBe("gpt-5.6-terra");
    expect(parsed[0]?.errorMessage).toBeNull();
  });

  it("never carries workspace names or paths out of the payload", () => {
    const parsed = parseCodexBarCostPayload([
      {
        provider: "codex",
        daily: [],
        projects: [
          {
            name: "CANARY_PROJECT_DO_NOT_UPLOAD",
            path: "/Users/someone/Repos/CANARY_PATH_DO_NOT_UPLOAD",
            totalTokens: 10,
            totalCost: 1
          }
        ]
      }
    ]);

    expect(JSON.stringify(parsed)).not.toContain("CANARY_PROJECT_DO_NOT_UPLOAD");
    expect(JSON.stringify(parsed)).not.toContain("CANARY_PATH_DO_NOT_UPLOAD");
    expect(JSON.stringify(parsed)).not.toContain("projects");
  });

  it("keeps healthy rows when one provider reports an error", () => {
    const parsed = parseCodexBarCostPayload([
      { provider: "codex", daily: [{ date: "2026-08-31", totalTokens: 5 }] },
      { provider: "claude", error: { message: "cookie source is Off" }, daily: [] }
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.daily).toHaveLength(1);
    expect(parsed[1]?.errorMessage).toBe("cookie source is Off");
  });

  it("drops malformed entries instead of rejecting the document", () => {
    const parsed = parseCodexBarCostPayload([
      null,
      { source: "local" },
      {
        provider: "codex",
        daily: [{ date: "not-a-date", totalTokens: 5 }, { date: "2026-08-31", totalTokens: 5 }]
      }
    ]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.daily.map((day) => day.date)).toEqual(["2026-08-31"]);
  });

  it("returns nothing for a non-array document", () => {
    expect(parseCodexBarCostPayload({ error: "unauthorized" })).toEqual([]);
    expect(parseCodexBarCostPayload(null)).toEqual([]);
  });
});

describe("codexbar token lane reconciliation", () => {
  it("splits Codex days whose input lane already includes cache reads", () => {
    const lanes = codexBarDailyLanes(
      daily({
        inputTokens: 32_148_427,
        cacheReadTokens: 31_412_352,
        outputTokens: 82_597,
        totalTokens: 32_231_024
      })
    );

    expect(lanes.reconciled).toBe(true);
    expect(lanes.inputTokens).toBe(32_148_427 - 31_412_352);
    expect(
      lanes.inputTokens + lanes.cacheReadTokens + lanes.cacheCreationTokens + lanes.outputTokens
    ).toBe(32_231_024);
  });

  it("keeps Claude days whose input lane already excludes both cache lanes", () => {
    const lanes = codexBarDailyLanes(
      daily({
        inputTokens: 16_774,
        cacheReadTokens: 113_507_272,
        cacheCreationTokens: 2_770_761,
        outputTokens: 330_327,
        totalTokens: 116_625_134
      })
    );

    expect(lanes.reconciled).toBe(true);
    expect(lanes.inputTokens).toBe(16_774);
    expect(
      lanes.inputTokens + lanes.cacheReadTokens + lanes.cacheCreationTokens + lanes.outputTokens
    ).toBe(116_625_134);
  });

  it("still matches the reported total when neither convention reconciles", () => {
    const lanes = codexBarDailyLanes(
      daily({ inputTokens: 1, cacheReadTokens: 2, outputTokens: 3, totalTokens: 100 })
    );

    expect(lanes.reconciled).toBe(false);
    expect(
      lanes.inputTokens + lanes.cacheReadTokens + lanes.cacheCreationTokens + lanes.outputTokens
    ).toBe(100);
  });
});

describe("codexbar provider argument", () => {
  // A repeated `--provider` flag makes CodexBar keep only the last value, which
  // would silently drop a provider's usage instead of failing.
  it("collapses the Codex and Claude pair onto CodexBar's `both`", () => {
    expect(codexBarProviderArgument(["codex", "claude"])).toBe("both");
    expect(codexBarProviderArgument(["claude", "codex"])).toBe("both");
  });

  it("passes a single supported provider through", () => {
    expect(codexBarProviderArgument(["codex"])).toBe("codex");
    expect(codexBarProviderArgument(["claude"])).toBe("claude");
  });

  it("returns null when no requested provider is covered by codexbar cost", () => {
    expect(codexBarProviderArgument(["opencode"])).toBeNull();
    expect(codexBarProviderArgument([])).toBeNull();
  });

  it("ignores providers codexbar cost does not price", () => {
    expect(codexBarProviderArgument(["opencode", "codex"])).toBe("codex");
  });
});

describe("codexbar version parsing", () => {
  it("reads the version out of the CLI banner", () => {
    expect(parseCodexBarVersion("CodexBar 0.56.2\n")).toBe("0.56.2");
    expect(parseCodexBarVersion("0.57.0-beta.1")).toBe("0.57.0-beta.1");
  });

  it("returns null when no version is present", () => {
    expect(parseCodexBarVersion("command not found")).toBeNull();
  });
});

describe("codexbar binary discovery", () => {
  it("prefers an explicit CODEXBAR_BIN override", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codexbar-bin-"));
    const override = await writeExecutable(join(dir, "custom-codexbar"));

    expect(await findCodexBarBinary({ CODEXBAR_BIN: override, PATH: "" })).toBe(override);
  });

  it("does not fall through when CODEXBAR_BIN is not executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codexbar-bin-"));
    const onPath = await writeExecutable(join(dir, "codexbar"));

    expect(
      await findCodexBarBinary({ CODEXBAR_BIN: join(dir, "missing"), PATH: dir }, [])
    ).toBeNull();
    expect(await findCodexBarBinary({ PATH: dir }, [])).toBe(onPath);
  });

  it("falls back to the install locations CodexBar symlinks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codexbar-wellknown-"));
    const installed = await writeExecutable(join(dir, "CodexBarCLI"));

    expect(await findCodexBarBinary({ PATH: "" }, [join(dir, "absent"), installed])).toBe(
      installed
    );
  });

  it("returns null when nothing is installed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codexbar-empty-"));

    expect(await findCodexBarBinary({ PATH: dir }, [])).toBeNull();
  });
});
