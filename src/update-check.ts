import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CollectorConfig } from "./config.js";
import { COLLECTOR_VERSION } from "./types.js";

const REGISTRY_LATEST_URL = "https://registry.npmjs.org/trmnl-token-meter/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_TIMEOUT_MS = 900;

export interface UpdateCheckCache {
  last_checked_at: string;
  latest_version: string | null;
}

type Fetch = typeof fetch;

async function readCache(path: string): Promise<UpdateCheckCache | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as UpdateCheckCache;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function writeCache(path: string, latestVersion: string | null, now: Date): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        last_checked_at: now.toISOString(),
        latest_version: latestVersion
      } satisfies UpdateCheckCache,
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
}

function stale(cache: UpdateCheckCache | null, now: Date): boolean {
  if (!cache) return true;
  const checkedAt = new Date(cache.last_checked_at);
  if (Number.isNaN(checkedAt.getTime())) return true;
  return now.getTime() - checkedAt.getTime() >= CHECK_INTERVAL_MS;
}

function versionParts(version: string): number[] {
  return version
    .replace(/^v/, "")
    .split(/[.-]/)
    .slice(0, 3)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
}

export function isNewerVersion(latest: string, current = COLLECTOR_VERSION): boolean {
  const latestParts = versionParts(latest);
  const currentParts = versionParts(current);
  for (let index = 0; index < 3; index += 1) {
    const latestPart = latestParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }
  return false;
}

async function latestPackageVersion(fetchImpl: Fetch, timeoutMs = UPDATE_TIMEOUT_MS): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(REGISTRY_LATEST_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const body = (await response.json().catch(() => null)) as { version?: unknown } | null;
    return typeof body?.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function updateNotice(
  config: CollectorConfig,
  options: {
    args?: string[];
    env?: NodeJS.ProcessEnv;
    fetchImpl?: Fetch;
    now?: Date;
    currentVersion?: string;
  } = {}
): Promise<string | null> {
  const args = options.args ?? [];
  const env = options.env ?? process.env;
  if (env.TRMNL_TOKEN_METER_DISABLE_UPDATE_CHECK === "1" || args.includes("--no-update-check")) {
    return null;
  }

  const now = options.now ?? new Date();
  const cache = await readCache(config.updateCheckPath);
  let latestVersion = cache?.latest_version ?? null;
  if (stale(cache, now)) {
    latestVersion = await latestPackageVersion(options.fetchImpl ?? fetch);
    await writeCache(config.updateCheckPath, latestVersion, now).catch(() => undefined);
  }

  if (!latestVersion || !isNewerVersion(latestVersion, options.currentVersion ?? COLLECTOR_VERSION)) {
    return null;
  }

  return `Update available: trmnl-token-meter ${options.currentVersion ?? COLLECTOR_VERSION} -> ${latestVersion}

Update with:
  npm install -g trmnl-token-meter@latest
`;
}
