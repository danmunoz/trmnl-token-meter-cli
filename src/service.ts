import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CollectorConfig } from "./config.js";
import { COLLECTOR_VERSION } from "./types.js";

const execFileAsync = promisify(execFile);
const SERVICE_LABEL = "com.trmnl.token-meter.sync";
const CRON_BEGIN = "# BEGIN trmnl-token-meter";
const CRON_END = "# END trmnl-token-meter";

export interface ServiceMetadata {
  installed_at: string;
  method: "launchd" | "systemd" | "cron";
  runner: string;
  interval_minutes: number;
  runner_version?: string;
}

export interface SyncState {
  last_sync_at: string | null;
  last_status: "success" | "error" | null;
  last_error?: string;
}

export interface ServiceStatus {
  installed: boolean;
  method: ServiceMetadata["method"] | null;
  runner: string | null;
  runner_version: string | null;
  current_version: string;
  interval_minutes: number | null;
  last_sync_at: string | null;
  last_status: SyncState["last_status"];
  last_error?: string;
}

type CommandRunner = (file: string, args: string[]) => Promise<void>;
type TextRunner = (file: string, args: string[]) => Promise<string>;

const defaultCommandRunner: CommandRunner = async (file, args) => {
  await execFileAsync(file, args);
};

const defaultTextRunner: TextRunner = async (file, args) => {
  const result = await execFileAsync(file, args);
  return String(result.stdout);
};

function commandFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const failure = error as Error & { stderr?: unknown; stdout?: unknown };
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  const stdout = typeof failure.stdout === "string" ? failure.stdout.trim() : "";
  if (stderr) return `${failure.message}: ${stderr}`;
  if (stdout) return `${failure.message}: ${stdout}`;
  return failure.message;
}

const xmlEscape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

function envForService(config: CollectorConfig): Record<string, string> {
  return {
    CODEX_HOME: config.codexHome,
    TRMNL_TOKEN_METER_CONFIG_DIR: config.configDir,
    TRMNL_TOKEN_METER_CACHE_DIR: config.cacheDir,
    TRMNL_TOKEN_METER_INCLUDE_PI_SESSIONS: config.includePiSessions ? "1" : "0",
    PI_HOME: config.piSessionsHome
  };
}

function currentRuntimeDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

function stableRunnerSourceDir(): string {
  const runtimeDir = currentRuntimeDir();
  if (basename(fileURLToPath(import.meta.url)) === "cli.js") return runtimeDir;
  return join(dirname(runtimeDir), "dist");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function stableRunnerDir(config: CollectorConfig): string {
  return join(config.serviceDir, "dist");
}

async function verifyStableRunner(runner: string): Promise<void> {
  try {
    const version = (
      await defaultTextRunner(process.execPath, [runner, "--version", "--no-update-check"])
    )
      .trim()
      .split("\n")[0]
      ?.trim();
    if (version !== COLLECTOR_VERSION) {
      throw new Error(
        `expected ${COLLECTOR_VERSION}, received ${version && version.length > 0 ? version : "empty output"}`
      );
    }
  } catch (error) {
    throw new Error(`Could not verify service runner installation: ${commandFailureMessage(error)}`, {
      cause: error
    });
  }
}

export async function installStableRunner(
  config: CollectorConfig,
  sourceDir = stableRunnerSourceDir()
): Promise<string> {
  const distDir = stableRunnerDir(config);
  if (!(await pathExists(join(sourceDir, "cli.js")))) {
    throw new Error("Could not find a built CLI runtime. Run `pnpm build` before installing background sync.");
  }
  await rm(distDir, { recursive: true, force: true });
  await mkdir(config.serviceDir, { recursive: true, mode: 0o700 });
  await cp(sourceDir, distDir, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules"
  });
  await writeFile(
    join(config.serviceDir, "package.json"),
    `${JSON.stringify(
      {
        name: "trmnl-token-meter",
        type: "module",
        version: COLLECTOR_VERSION
      },
      null,
      2
    )}\n`,
    {
      mode: 0o600
    }
  );
  const runner = join(distDir, "cli.js");
  await verifyStableRunner(runner);
  return runner;
}

function launchdPlist(config: CollectorConfig, runner: string, intervalMinutes: number): string {
  const env = envForService(config);
  const envXml = Object.entries(env)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(runner)}</string>
    <string>sync</string>
    <string>--once</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>${Math.max(60, intervalMinutes * 60)}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(config.cacheDir, "service.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(config.cacheDir, "service.err.log"))}</string>
</dict>
</plist>
`;
}

function systemdService(config: CollectorConfig, runner: string): string {
  const env = Object.entries(envForService(config))
    .map(([key, value]) => `Environment="${key}=${value.replaceAll('"', '\\"')}"`)
    .join("\n");
  return `[Unit]
Description=TRMNL Token Meter sync

[Service]
Type=oneshot
${env}
ExecStart="${process.execPath}" "${runner}" sync --once
`;
}

function systemdTimer(intervalMinutes: number): string {
  return `[Unit]
Description=Run TRMNL Token Meter sync

[Timer]
OnBootSec=2min
OnUnitActiveSec=${Math.max(1, intervalMinutes)}min
Unit=trmnl-token-meter.service

[Install]
WantedBy=timers.target
`;
}

async function installLaunchd(
  config: CollectorConfig,
  runner: string,
  intervalMinutes: number,
  runCommand: CommandRunner
): Promise<void> {
  const plistPath = join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, launchdPlist(config, runner, intervalMinutes), { mode: 0o600 });
  const target = `gui/${process.getuid?.() ?? ""}`;
  await runCommand("launchctl", ["bootout", target, plistPath]).catch(() => undefined);
  await runCommand("launchctl", ["bootstrap", target, plistPath]);
}

async function installSystemd(
  config: CollectorConfig,
  runner: string,
  intervalMinutes: number,
  runCommand: CommandRunner
): Promise<void> {
  const userDir = join(homedir(), ".config", "systemd", "user");
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, "trmnl-token-meter.service"), systemdService(config, runner), {
    mode: 0o600
  });
  await writeFile(join(userDir, "trmnl-token-meter.timer"), systemdTimer(intervalMinutes), {
    mode: 0o600
  });
  await runCommand("systemctl", ["--user", "daemon-reload"]);
  await runCommand("systemctl", ["--user", "enable", "--now", "trmnl-token-meter.timer"]);
}

async function installCron(
  config: CollectorConfig,
  runner: string,
  intervalMinutes: number,
  runCommand: CommandRunner
): Promise<void> {
  const existing = await execFileAsync("crontab", ["-l"]).then(
    (result) => String(result.stdout),
    () => ""
  );
  const command = [
    ...Object.entries(envForService(config)).map(([key, value]) => `${key}=${shellQuote(value)}`),
    shellQuote(process.execPath),
    shellQuote(runner),
    "sync",
    "--due",
    String(Math.max(1, intervalMinutes))
  ].join(" ");
  const schedule = `* * * * * ${command}`;
  const stripped = existing.replace(
    new RegExp(`\\n?${CRON_BEGIN}[\\s\\S]*?${CRON_END}\\n?`, "m"),
    "\n"
  );
  const next = `${stripped.trim()}\n${CRON_BEGIN}\n${schedule}\n${CRON_END}\n`;
  const file = join(config.cacheDir, "crontab");
  await writeFile(file, next, { mode: 0o600 });
  await runCommand("crontab", [file]);
}

async function writeServiceMetadata(config: CollectorConfig, metadata: ServiceMetadata): Promise<void> {
  await writeFile(config.serviceMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600
  });
}

export async function installBackgroundService(
  config: CollectorConfig,
  intervalMinutes: number,
  options: { sourceDir?: string; runCommand?: CommandRunner } = {}
): Promise<ServiceMetadata> {
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const runner = await installStableRunner(config, options.sourceDir);
  let method: ServiceMetadata["method"];
  if (platform() === "darwin") {
    await installLaunchd(config, runner, intervalMinutes, runCommand);
    method = "launchd";
  } else if (platform() === "linux") {
    try {
      await installSystemd(config, runner, intervalMinutes, runCommand);
      method = "systemd";
    } catch {
      await installCron(config, runner, intervalMinutes, runCommand);
      method = "cron";
    }
  } else {
    await installCron(config, runner, intervalMinutes, runCommand);
    method = "cron";
  }

  const metadata: ServiceMetadata = {
    installed_at: new Date().toISOString(),
    method,
    runner,
    interval_minutes: intervalMinutes,
    runner_version: COLLECTOR_VERSION
  };
  await writeServiceMetadata(config, metadata);
  return metadata;
}

export async function uninstallBackgroundService(
  config: CollectorConfig,
  options: { runCommand?: CommandRunner; removeRunner?: boolean } = {}
): Promise<void> {
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const metadata = await readServiceMetadata(config);
  if (metadata?.method === "launchd") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    const target = `gui/${process.getuid?.() ?? ""}`;
    await runCommand("launchctl", ["bootout", target, plistPath]).catch(() => undefined);
    await rm(plistPath, { force: true });
  } else if (metadata?.method === "systemd") {
    await runCommand("systemctl", ["--user", "disable", "--now", "trmnl-token-meter.timer"]).catch(
      () => undefined
    );
    await rm(join(homedir(), ".config", "systemd", "user", "trmnl-token-meter.timer"), {
      force: true
    });
    await rm(join(homedir(), ".config", "systemd", "user", "trmnl-token-meter.service"), {
      force: true
    });
    await runCommand("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
  } else if (metadata?.method === "cron") {
    const existing = await execFileAsync("crontab", ["-l"]).then(
      (result) => String(result.stdout),
      () => ""
    );
    const next = existing.replace(
      new RegExp(`\\n?${CRON_BEGIN}[\\s\\S]*?${CRON_END}\\n?`, "m"),
      "\n"
    );
    const file = join(config.cacheDir, "crontab");
    await writeFile(file, next.trim() ? `${next.trim()}\n` : "", { mode: 0o600 });
    await runCommand("crontab", [file]).catch(() => undefined);
  }
  await rm(config.serviceMetadataPath, { force: true });
  if (options.removeRunner) await rm(config.serviceDir, { recursive: true, force: true });
}

async function readServiceMetadata(config: CollectorConfig): Promise<ServiceMetadata | null> {
  try {
    return JSON.parse(await readFile(config.serviceMetadataPath, "utf8")) as ServiceMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function refreshInstalledRunner(
  config: CollectorConfig,
  options: { sourceDir?: string } = {}
): Promise<boolean> {
  const metadata = await readServiceMetadata(config);
  if (!metadata) return false;

  const sourceDir = options.sourceDir ?? stableRunnerSourceDir();
  const distDir = stableRunnerDir(config);
  const expectedRunner = join(distDir, "cli.js");

  if (sourceDir === distDir) return false;
  if (!(await pathExists(join(sourceDir, "cli.js")))) return false;
  if (
    metadata.runner === expectedRunner &&
    metadata.runner_version === COLLECTOR_VERSION &&
    (await pathExists(expectedRunner))
  ) {
    return false;
  }

  const runner = await installStableRunner(config, sourceDir);
  await writeServiceMetadata(config, {
    ...metadata,
    runner,
    runner_version: COLLECTOR_VERSION
  });
  return true;
}

async function readRunnerVersion(metadata: ServiceMetadata | null): Promise<string | null> {
  if (!metadata?.runner || !(await pathExists(metadata.runner))) {
    return metadata?.runner_version ?? null;
  }

  try {
    const version = (await defaultTextRunner(process.execPath, [metadata.runner, "--version", "--no-update-check"]))
      .trim()
      .split("\n")[0]
      ?.trim();
    return version || metadata.runner_version || null;
  } catch {
    return metadata?.runner_version ?? null;
  }
}

export async function saveSyncState(
  config: CollectorConfig,
  state: Omit<SyncState, "last_sync_at"> & { last_sync_at?: string | null }
): Promise<void> {
  await mkdir(dirname(config.serviceStatePath), { recursive: true, mode: 0o700 });
  await writeFile(
    config.serviceStatePath,
    `${JSON.stringify({ last_sync_at: new Date().toISOString(), ...state }, null, 2)}\n`,
    { mode: 0o600 }
  );
}

export async function readSyncState(config: CollectorConfig): Promise<SyncState | null> {
  try {
    return JSON.parse(await readFile(config.serviceStatePath, "utf8")) as SyncState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function isSyncDue(
  config: CollectorConfig,
  intervalMinutes: number,
  now = new Date()
): Promise<boolean> {
  const state = await readSyncState(config);
  const lastSync = state?.last_sync_at ? new Date(state.last_sync_at) : null;
  if (!lastSync || Number.isNaN(lastSync.getTime())) return true;
  return now.getTime() - lastSync.getTime() >= Math.max(1, intervalMinutes) * 60_000;
}

async function schedulerInstalled(
  config: CollectorConfig,
  metadata: ServiceMetadata,
  options: { runCommand?: CommandRunner; readCommandText?: TextRunner } = {}
): Promise<boolean> {
  const runCommand = options.runCommand ?? defaultCommandRunner;
  const readCommandText = options.readCommandText ?? defaultTextRunner;

  if (metadata.method === "launchd") {
    const plistPath = join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    if (!(await pathExists(plistPath))) return false;
    try {
      await runCommand("launchctl", ["print", `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`]);
      return true;
    } catch {
      return false;
    }
  }

  if (metadata.method === "systemd") {
    const userDir = join(homedir(), ".config", "systemd", "user");
    if (
      !(await pathExists(join(userDir, "trmnl-token-meter.timer"))) ||
      !(await pathExists(join(userDir, "trmnl-token-meter.service")))
    ) {
      return false;
    }
    try {
      await runCommand("systemctl", ["--user", "is-enabled", "trmnl-token-meter.timer"]);
      return true;
    } catch {
      return false;
    }
  }

  try {
    const current = await readCommandText("crontab", ["-l"]);
    return current.includes(CRON_BEGIN) && current.includes(CRON_END);
  } catch {
    return false;
  }
}

export async function serviceStatus(config: CollectorConfig): Promise<ServiceStatus> {
  const [metadata, state] = await Promise.all([readServiceMetadata(config), readSyncState(config)]);
  const runnerVersion = await readRunnerVersion(metadata);
  const installed =
    Boolean(metadata && (await pathExists(metadata.runner))) &&
    Boolean(metadata && (await schedulerInstalled(config, metadata)));
  return {
    installed,
    method: metadata?.method ?? null,
    runner: metadata?.runner ?? null,
    runner_version: runnerVersion,
    current_version: COLLECTOR_VERSION,
    interval_minutes: metadata?.interval_minutes ?? null,
    last_sync_at: state?.last_sync_at ?? null,
    last_status: state?.last_status ?? null,
    ...(state?.last_error ? { last_error: state.last_error } : {})
  };
}
