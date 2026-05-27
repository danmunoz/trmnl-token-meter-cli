import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectorConfig } from "./config.js";
import { SUPPORTED_PROVIDERS } from "./source-providers.js";
import type { ProviderStatus, SourceProvider, WarningCode } from "./types.js";

const codeForStatus = (
  provider: SourceProvider,
  status: "missing" | "unreadable"
): WarningCode | undefined => {
  if (status !== "missing" && status !== "unreadable") return undefined;
  if (provider === "codex") return "codex_sessions_missing";
  if (provider === "opencode") return "opencode_sqlite_missing";
  return undefined;
};

const pathStatus = async (path: string, provider: SourceProvider): Promise<ProviderStatus> => {
  try {
    await access(path, constants.R_OK);
    return { provider, status: "available" };
  } catch (error) {
    const status = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
    const warning_code = codeForStatus(provider, status);
    if (warning_code) return { provider, status, warning_code };
    return { provider, status };
  }
};

const defaultClaudeRoots = (config: CollectorConfig): string[] => {
  if (config.claudeProjectsRoots?.length) return config.claudeProjectsRoots;
  return [join(homedir(), ".config", "claude", "projects"), join(homedir(), ".claude", "projects")];
};

async function probeCodex(config: CollectorConfig): Promise<ProviderStatus> {
  return pathStatus(join(config.codexHome, "sessions"), "codex");
}

async function probeOpenCode(config: CollectorConfig): Promise<ProviderStatus> {
  return pathStatus(config.opencodeDbPath, "opencode");
}

async function probeClaude(config: CollectorConfig): Promise<ProviderStatus> {
  for (const root of defaultClaudeRoots(config)) {
    const status = await pathStatus(root, "claude");
    if (status.status === "available") {
      return status;
    }
  }
  return { provider: "claude", status: "missing" };
}

export async function probeProviderStatus(
  config: CollectorConfig,
  provider: SourceProvider
): Promise<ProviderStatus> {
  switch (provider) {
    case "codex":
      return probeCodex(config);
    case "opencode":
      return probeOpenCode(config);
    case "claude":
      return probeClaude(config);
  }
}

export const probeProviderStatuses = async (config: CollectorConfig): Promise<ProviderStatus[]> =>
  Promise.all(SUPPORTED_PROVIDERS.map((provider) => probeProviderStatus(config, provider)));
