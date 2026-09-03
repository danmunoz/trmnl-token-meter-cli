import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CollectorCredential, SourceNoticeState } from "./types.js";
import { parseProviders } from "./source-providers.js";
import {
  CODEXBAR_DEFAULT_DAYS,
  CODEXBAR_DEFAULT_TIMEOUT_MS
} from "./cost-sources/codexbar-cli.js";

const DEFAULT_API_BASE_URL = "https://trmnl-token-meter-backend.trmnltkn.workers.dev";
export const CONFIG_DISABLED_PROVIDERS_SENTINEL = "none";

export interface CollectorConfig {
  apiBaseUrl: string;
  codexHome: string;
  codexHomeKind: "default" | "custom";
  configDir: string;
  cacheDir: string;
  credentialPath: string;
  serviceDir: string;
  serviceStatePath: string;
  serviceMetadataPath: string;
  sourceNoticeStatePath: string;
  updateCheckPath: string;
  logLevel: string;
  includePiSessions: boolean;
  piSessionsHome: string;
  opencodeDbPath: string;
  claudeProjectsRoots: string[] | null;
  enabledProviders: ReturnType<typeof parseProviders>;
  /**
   * Whether a locally installed CodexBar may price Codex and Claude usage.
   * `auto` uses it when it is installed; `off` always uses the bundled catalog.
   */
  codexBarMode: "auto" | "off";
  /** Explicit CodexBar binary from `CODEXBAR_BIN`; null falls back to discovery. */
  codexBarBin: string | null;
  codexBarDays: number;
  codexBarTimeoutMs: number;
}

const positiveIntegerSetting = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const isLoopbackHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";

export function normalizeApiBaseUrl(
  value: string,
  options: { expectedOrigin?: string } = {}
): string {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("API base URL must not include embedded credentials.");
  }
  if (url.protocol !== "https:" && !isLoopbackHost(url.hostname)) {
    throw new Error("API base URL must use HTTPS unless it targets localhost.");
  }
  if (options.expectedOrigin && url.origin !== options.expectedOrigin) {
    throw new Error("Pairing response returned an unexpected API origin.");
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = normalizedPath || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function defaultConfigDir(): string {
  if (process.env.TRMNL_TOKEN_METER_CONFIG_DIR) return process.env.TRMNL_TOKEN_METER_CONFIG_DIR;
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "trmnl-token-meter");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "trmnl-token-meter");
}

function defaultCacheDir(): string {
  if (process.env.TRMNL_TOKEN_METER_CACHE_DIR) return process.env.TRMNL_TOKEN_METER_CACHE_DIR;
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "trmnl-token-meter");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "trmnl-token-meter");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const codexHome =
    env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME : join(homedir(), ".codex");
  const configDir = env.TRMNL_TOKEN_METER_CONFIG_DIR ?? defaultConfigDir();
  const cacheDir = env.TRMNL_TOKEN_METER_CACHE_DIR ?? defaultCacheDir();
  const apiBaseUrl = env.TRMNL_TOKEN_METER_API_BASE_URL ?? DEFAULT_API_BASE_URL;
  const claudeProjectsInput =
    env.TRMNL_TOKEN_METER_CLAUDE_PROJECTS_HOME ?? env.TRMNL_TOKEN_METER_CLAUDE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR;
  const enabledProviders =
    env.TRMNL_TOKEN_METER_ENABLED_PROVIDERS === CONFIG_DISABLED_PROVIDERS_SENTINEL
      ? []
      : parseProviders(env.TRMNL_TOKEN_METER_ENABLED_PROVIDERS, ["codex"]);
  return {
    apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
    codexHome: resolve(codexHome),
    codexHomeKind: env.CODEX_HOME && env.CODEX_HOME.trim() ? "custom" : "default",
    configDir: resolve(configDir),
    cacheDir: resolve(cacheDir),
    credentialPath: resolve(configDir, "credentials.json"),
    serviceDir: resolve(configDir, "service-runner"),
    serviceStatePath: resolve(configDir, "sync-state.json"),
    serviceMetadataPath: resolve(configDir, "service.json"),
    sourceNoticeStatePath: resolve(configDir, "source-state.json"),
    updateCheckPath: resolve(configDir, "update-check.json"),
    logLevel: env.LOG_LEVEL ?? "info",
    includePiSessions: env.TRMNL_TOKEN_METER_INCLUDE_PI_SESSIONS === "1",
    piSessionsHome: resolve(env.PI_HOME ?? join(homedir(), ".pi")),
    opencodeDbPath: resolve(
      env.TRMNL_TOKEN_METER_OPENCODE_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db")
    ),
    claudeProjectsRoots: claudeProjectsInput
      ? claudeProjectsInput
          .split(",")
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const path = resolve(part);
            return path.split(/[\\/]/).at(-1) === "projects" ? path : join(path, "projects");
          })
      : null,
    enabledProviders,
    codexBarMode: env.TRMNL_TOKEN_METER_CODEXBAR === "off" ? "off" : "auto",
    codexBarBin: env.CODEXBAR_BIN?.trim() || null,
    codexBarDays: positiveIntegerSetting(
      env.TRMNL_TOKEN_METER_CODEXBAR_DAYS,
      CODEXBAR_DEFAULT_DAYS
    ),
    codexBarTimeoutMs: positiveIntegerSetting(
      env.TRMNL_TOKEN_METER_CODEXBAR_TIMEOUT_MS,
      CODEXBAR_DEFAULT_TIMEOUT_MS
    )
  };
}

export async function ensureCollectorDirs(config: CollectorConfig): Promise<void> {
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  await mkdir(config.cacheDir, { recursive: true, mode: 0o700 });
}

export async function saveCredential(path: string, credential: CollectorCredential): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
}

export async function loadCredential(path: string): Promise<CollectorCredential | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as CollectorCredential;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const defaultSourceNoticeState: SourceNoticeState = {
  known_supported_providers: ["codex"]
};

export async function loadSourceNoticeState(config: CollectorConfig): Promise<SourceNoticeState> {
  try {
    return (JSON.parse(await readFile(config.sourceNoticeStatePath, "utf8")) as SourceNoticeState) ?? defaultSourceNoticeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultSourceNoticeState;
    throw error;
  }
}

export async function saveSourceNoticeState(
  config: CollectorConfig,
  state: SourceNoticeState
): Promise<void> {
  await mkdir(dirname(config.sourceNoticeStatePath), { recursive: true, mode: 0o700 });
  await writeFile(config.sourceNoticeStatePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export async function deleteCredential(path: string): Promise<void> {
  await rm(path, { force: true });
}
