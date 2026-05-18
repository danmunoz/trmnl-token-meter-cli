import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CollectorCredential } from "./types.js";

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
  updateCheckPath: string;
  logLevel: string;
  includePiSessions: boolean;
  piSessionsHome: string;
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
  const apiBaseUrl = env.TRMNL_TOKEN_METER_API_BASE_URL ?? "http://localhost:3000";
  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    codexHome: resolve(codexHome),
    codexHomeKind: env.CODEX_HOME && env.CODEX_HOME.trim() ? "custom" : "default",
    configDir: resolve(configDir),
    cacheDir: resolve(cacheDir),
    credentialPath: resolve(configDir, "credentials.json"),
    serviceDir: resolve(configDir, "service-runner"),
    serviceStatePath: resolve(configDir, "sync-state.json"),
    serviceMetadataPath: resolve(configDir, "service.json"),
    updateCheckPath: resolve(configDir, "update-check.json"),
    logLevel: env.LOG_LEVEL ?? "info",
    includePiSessions: env.TRMNL_TOKEN_METER_INCLUDE_PI_SESSIONS === "1",
    piSessionsHome: resolve(env.PI_HOME ?? join(homedir(), ".pi"))
  };
}

export async function ensureCollectorDirs(config: CollectorConfig): Promise<void> {
  await mkdir(config.configDir, { recursive: true, mode: 0o700 });
  await mkdir(config.cacheDir, { recursive: true, mode: 0o700 });
}

export function codexHomeExists(config: CollectorConfig): boolean {
  return existsSync(config.codexHome);
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

export async function deleteCredential(path: string): Promise<void> {
  await rm(path, { force: true });
}
