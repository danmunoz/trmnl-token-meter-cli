import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CollectorConfig } from "./config.js";

const execFileAsync = promisify(execFile);
const SERVICE_LABEL = "com.trmnl.token-meter.sync";
const CRON_BEGIN = "# BEGIN trmnl-token-meter";
const CRON_END = "# END trmnl-token-meter";

export interface ServiceMetadata {
  installed_at: string;
  method: "launchd" | "systemd" | "cron";
  runner: string;
  interval_minutes: number;
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
  interval_minutes: number | null;
  last_sync_at: string | null;
  last_status: SyncState["last_status"];
  last_error?: string;
}

type CommandRunner = (file: string, args: string[]) => Promise<void>;

const defaultCommandRunner: CommandRunner = async (file, args) => {
  await execFileAsync(file, args);
};

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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function installStableRunner(
  config: CollectorConfig,
  sourceDir = currentRuntimeDir()
): Promise<string> {
  const distDir = join(config.serviceDir, "dist");
  await rm(distDir, { recursive: true, force: true });
  await mkdir(config.serviceDir, { recursive: true, mode: 0o700 });
  await cp(sourceDir, distDir, {
    recursive: true,
    filter: (source) => basename(source) !== "node_modules"
  });
  await writeFile(join(config.serviceDir, "package.json"), "{\"type\":\"module\"}\n", {
    mode: 0o600
  });
  return join(distDir, "cli.js");
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
    "--once"
  ].join(" ");
  const schedule = `*/${Math.max(1, intervalMinutes)} * * * * ${command}`;
  const stripped = existing.replace(
    new RegExp(`\\n?${CRON_BEGIN}[\\s\\S]*?${CRON_END}\\n?`, "m"),
    "\n"
  );
  const next = `${stripped.trim()}\n${CRON_BEGIN}\n${schedule}\n${CRON_END}\n`;
  const file = join(config.cacheDir, "crontab");
  await writeFile(file, next, { mode: 0o600 });
  await runCommand("crontab", [file]);
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
    interval_minutes: intervalMinutes
  };
  await writeFile(config.serviceMetadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600
  });
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

export async function readServiceMetadata(config: CollectorConfig): Promise<ServiceMetadata | null> {
  try {
    return JSON.parse(await readFile(config.serviceMetadataPath, "utf8")) as ServiceMetadata;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function saveSyncState(
  config: CollectorConfig,
  state: Omit<SyncState, "last_sync_at"> & { last_sync_at?: string | null }
): Promise<void> {
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

export async function serviceStatus(config: CollectorConfig): Promise<ServiceStatus> {
  const [metadata, state] = await Promise.all([readServiceMetadata(config), readSyncState(config)]);
  return {
    installed: Boolean(metadata && (await pathExists(metadata.runner))),
    method: metadata?.method ?? null,
    runner: metadata?.runner ?? null,
    interval_minutes: metadata?.interval_minutes ?? null,
    last_sync_at: state?.last_sync_at ?? null,
    last_status: state?.last_status ?? null,
    ...(state?.last_error ? { last_error: state.last_error } : {})
  };
}
