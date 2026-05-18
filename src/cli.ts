#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { buildAggregate } from "./aggregate.js";
import {
  deleteCredential,
  ensureCollectorDirs,
  loadConfig,
  loadCredential,
  saveCredential,
  type CollectorConfig
} from "./config.js";
import { scanLocalCostSources } from "./cost-scan.js";
import { safeErrorMessage } from "./redact.js";
import {
  getCollectorStatus,
  isCollectorApiError,
  pairCollector,
  revokeCollector,
  serializeAggregateForUpload,
  uploadAggregate
} from "./upload.js";
import {
  installBackgroundService,
  readSyncState,
  saveSyncState,
  serviceStatus,
  uninstallBackgroundService
} from "./service.js";
import { COLLECTOR_VERSION, type AggregateSnapshot } from "./types.js";
import { updateNotice } from "./update-check.js";

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function shouldCheckForUpdates(command: string, argv: string[]): boolean {
  if (hasFlag(argv, "--no-update-check")) return false;
  return (
    argv.length === 0 ||
    command === "menu" ||
    command === "setup" ||
    command === "add" ||
    command === "status" ||
    command === "revoke" ||
    command === "unpair" ||
    command === "uninstall"
  );
}

async function maybePrintUpdateNotice(config: CollectorConfig, argv: string[]): Promise<void> {
  const notice = await updateNotice(config, { args: argv });
  if (notice) process.stderr.write(`${notice}\n`);
}

function printHelp(): void {
  process.stdout.write(`TRMNL Token Meter

Usage:
  trmnl-token-meter                 Open interactive setup/status UI
  trmnl-token-meter setup           Pair this machine and install background sync
  trmnl-token-meter status          Show pairing, service, and sync status
  trmnl-token-meter add             Add or replace the paired meter
  trmnl-token-meter revoke          Revoke this machine and stop background sync
  trmnl-token-meter uninstall       Remove background sync, optionally revoke
  trmnl-token-meter sync --once     Upload once for background services

Existing commands:
  trmnl-token-meter pair --code <code> [--machine-label <label>] [--api-base-url <url>] [--replace]
  trmnl-token-meter collect [--include-pi-sessions]
  trmnl-token-meter upload
  trmnl-token-meter run [--once]
`);
}

async function collectSnapshot(config: CollectorConfig): Promise<AggregateSnapshot> {
  const credential = await loadCredential(config.credentialPath);
  const scan = await scanLocalCostSources(config);
  return buildAggregate(scan.records, {
    machineId: credential?.machine_id ?? "unpaired",
    machineLabel: credential?.machine_label ?? hostname(),
    codexHomeKind: config.codexHomeKind,
    warnings: scan.warnings,
    sources: scan.sources
  });
}

async function pairCommand(args: string[], config: CollectorConfig): Promise<void> {
  const code = argValue(args, "--code");
  if (!code) throw new Error("Missing --code");
  const label = argValue(args, "--machine-label") ?? hostname();
  const apiBaseUrl = argValue(args, "--api-base-url") ?? config.apiBaseUrl;
  const existing = await loadCredential(config.credentialPath);
  if (existing && !hasFlag(args, "--replace")) {
    throw new Error("This machine is already paired. Use add, setup --replace, or pair --replace.");
  }
  if (existing) {
    await revokeCollector(existing).catch(() => undefined);
  }
  const credential = await pairCollector(apiBaseUrl, code, label, COLLECTOR_VERSION);
  await saveCredential(config.credentialPath, credential);
  process.stdout.write(`Paired ${credential.machine_id}\n`);
  process.stdout.write("Next: run `trmnl-token-meter service install` to install background sync.\n");
}

async function collectCommand(config: CollectorConfig): Promise<void> {
  const snapshot = await collectSnapshot(config);
  process.stdout.write(`${serializeAggregateForUpload(snapshot)}\n`);
}

async function uploadCommand(config: CollectorConfig): Promise<void> {
  await uploadOnce(config);
  process.stdout.write("Upload complete\n");
}

async function uploadOnce(config: CollectorConfig): Promise<void> {
  const credential = await loadCredential(config.credentialPath);
  if (!credential) throw new Error("Collector is not paired. Run pair first.");
  const snapshot = await collectSnapshot(config);
  try {
    await uploadAggregate(credential, snapshot);
    await saveSyncState(config, { last_status: "success" });
  } catch (error) {
    if (isCollectorApiError(error, "collector_revoked")) {
      await saveSyncState(config, { last_status: "error", last_error: "collector_revoked" });
      await uninstallBackgroundService(config, { removeRunner: true }).catch(() => undefined);
      throw new Error(
        "This meter was revoked on the server. Background sync was stopped. Run `trmnl-token-meter add` to pair again."
      );
    }
    await saveSyncState(config, { last_status: "error", last_error: safeErrorMessage(error) });
    throw error;
  }
}

async function syncCommand(args: string[], config: CollectorConfig): Promise<void> {
  if (!hasFlag(args, "--once")) throw new Error("sync currently requires --once");
  await uploadOnce(config);
}

async function runCommand(args: string[], config: CollectorConfig): Promise<void> {
  const once = hasFlag(args, "--once");
  await uploadCommand(config);
  if (once) return;

  const credential = await loadCredential(config.credentialPath);
  const minutes = Math.max(1, credential?.upload_interval_minutes ?? 15);
  setInterval(() => {
    uploadCommand(config).catch((error: unknown) => {
      process.stderr.write(`${safeErrorMessage(error)}\n`);
    });
  }, minutes * 60_000);
}

function openPrompt() {
  return createInterface({ input: process.stdin, output: process.stdout });
}

async function ask(question: string, fallback = ""): Promise<string> {
  const prompt = fallback ? `${question} (${fallback}): ` : `${question}: `;
  const rl = openPrompt();
  try {
    const answer = (await rl.question(prompt)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

async function confirm(question: string, fallback = false): Promise<boolean> {
  const suffix = fallback ? "Y/n" : "y/N";
  const answer = (await ask(`${question} [${suffix}]`)).toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

async function statusCommand(config: CollectorConfig): Promise<void> {
  const [credential, localService, syncState] = await Promise.all([
    loadCredential(config.credentialPath),
    serviceStatus(config),
    readSyncState(config)
  ]);

  process.stdout.write("TRMNL Token Meter Status\n\n");
  if (!credential) {
    process.stdout.write("Meter: not paired\n");
  } else {
    process.stdout.write(`Meter: paired as ${credential.machine_label} (${credential.machine_id})\n`);
    try {
      const remote = await getCollectorStatus(credential);
      process.stdout.write(`Server: ${remote.plugin_status} plugin, ${remote.machine_status} device\n`);
      process.stdout.write(`Last server sync: ${formatDate(remote.last_received_at)}\n`);
    } catch (error) {
      if (isCollectorApiError(error, "collector_revoked")) {
        process.stdout.write("Server: revoked\n");
        process.stdout.write(
          "This machine is no longer authorized to upload. Run `trmnl-token-meter add` to pair again, or `trmnl-token-meter uninstall` to remove local credentials.\n"
        );
      } else {
        process.stdout.write(`Server: ${safeErrorMessage(error)}\n`);
      }
    }
  }

  process.stdout.write(
    `Background sync: ${
      localService.installed
        ? `${localService.method} every ${localService.interval_minutes ?? "?"} minutes`
        : "not installed"
    }\n`
  );
  process.stdout.write(`Last local sync: ${formatDate(syncState?.last_sync_at)}\n`);
  if (syncState?.last_status === "error") {
    process.stdout.write(`Last sync error: ${safeErrorMessage(syncState.last_error)}\n`);
  }
}

async function installServiceCommand(config: CollectorConfig): Promise<void> {
  const credential = await loadCredential(config.credentialPath);
  if (!credential) throw new Error("Collector is not paired. Run setup first.");
  const metadata = await installBackgroundService(config, credential.upload_interval_minutes);
  process.stdout.write(
    `Background sync installed with ${metadata.method}; uploads run every ${metadata.interval_minutes} minutes.\n`
  );
}

async function uninstallServiceCommand(args: string[], config: CollectorConfig): Promise<void> {
  await uninstallBackgroundService(config, { removeRunner: hasFlag(args, "--purge") });
  process.stdout.write("Background sync removed\n");
}

async function serviceCommand(args: string[], config: CollectorConfig): Promise<void> {
  const [subcommand = "status", ...rest] = args;
  if (subcommand === "install") return installServiceCommand(config);
  if (subcommand === "uninstall") return uninstallServiceCommand(rest, config);
  if (subcommand === "status") return statusCommand(config);
  throw new Error(`Unknown service command: ${subcommand}`);
}

async function revokeCommand(args: string[], config: CollectorConfig): Promise<void> {
  const credential = await loadCredential(config.credentialPath);
  if (!credential) {
    await uninstallBackgroundService(config, { removeRunner: true }).catch(() => undefined);
    process.stdout.write("No paired meter found locally. Background sync removed if it was installed.\n");
    return;
  }

  if (!hasFlag(args, "--yes") && process.stdin.isTTY) {
    const ok = await confirm(
      `Revoke ${credential.machine_label} and stop syncing this TRMNL meter?`,
      false
    );
    if (!ok) {
      process.stdout.write("Cancelled\n");
      return;
    }
  }

  await uninstallBackgroundService(config, { removeRunner: true }).catch(() => undefined);
  try {
    await revokeCollector(credential);
  } catch (error) {
    if (!isCollectorApiError(error, "collector_revoked")) throw error;
    process.stdout.write("Meter was already revoked on the server.\n");
  }
  await deleteCredential(config.credentialPath);
  process.stdout.write("Meter revoked and local background sync removed\n");
}

async function uninstallCommand(args: string[], config: CollectorConfig): Promise<void> {
  await uninstallBackgroundService(config, { removeRunner: true }).catch(() => undefined);
  const credential = await loadCredential(config.credentialPath);
  const shouldRevoke =
    hasFlag(args, "--revoke") ||
    (!hasFlag(args, "--keep-meter") &&
      Boolean(credential) &&
      process.stdin.isTTY &&
      (await confirm("Also revoke this machine from the TRMNL meter?", false)));

  if (shouldRevoke && credential) {
    try {
      await revokeCollector(credential);
    } catch (error) {
      if (!isCollectorApiError(error, "collector_revoked")) throw error;
      process.stdout.write("Meter was already revoked on the server.\n");
    }
    await deleteCredential(config.credentialPath);
    process.stdout.write("Background sync removed and meter revoked\n");
    return;
  }

  process.stdout.write("Background sync removed. Pairing credentials were kept.\n");
}

async function setupCommand(args: string[], config: CollectorConfig): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("Interactive setup requires a terminal. Use pair/service commands for scripts.");
  }

  const existing = await loadCredential(config.credentialPath);
  if (existing) {
    const replace =
      hasFlag(args, "--replace") ||
      (await confirm(`This machine is already paired as ${existing.machine_label}. Replace that meter?`, false));
    if (!replace) {
      await statusCommand(config);
      return;
    }
    await revokeCollector(existing).catch(() => undefined);
    await deleteCredential(config.credentialPath);
  }

  process.stdout.write(`TRMNL Token Meter

This will sync sanitized Codex usage totals to your TRMNL display.
Raw prompts, responses, commands, file paths, and diffs stay on this machine.
After setup, uploads will continue automatically in the background.

`);

  const code = await ask("Pairing code");
  if (!code) throw new Error("Missing pairing code");
  const label = await ask("Machine name", hostname());
  const apiBaseUrl = argValue(args, "--api-base-url") ?? (await ask("Backend URL", config.apiBaseUrl));

  process.stdout.write("\nPairing...\n");
  const credential = await pairCollector(apiBaseUrl, code, label, COLLECTOR_VERSION);
  await saveCredential(config.credentialPath, credential);

  process.stdout.write("Uploading first snapshot...\n");
  await uploadOnce(config);

  process.stdout.write("Installing background sync...\n");
  const metadata = await installBackgroundService(config, credential.upload_interval_minutes);

  process.stdout.write(`\nDone.
This machine will sync automatically every ${metadata.interval_minutes} minutes using ${metadata.method}.
You can close this terminal.
`);
}

async function menuCommand(config: CollectorConfig): Promise<void> {
  if (!process.stdin.isTTY) {
    printHelp();
    return;
  }
  const credential = await loadCredential(config.credentialPath);
  if (!credential) return setupCommand([], config);

  process.stdout.write(`TRMNL Token Meter

Paired meter: ${credential.machine_label}

`);
  process.stdout.write("1. View status\n");
  process.stdout.write("2. Sync now\n");
  process.stdout.write("3. Add or replace meter\n");
  process.stdout.write("4. Revoke meter\n");
  process.stdout.write("5. Uninstall background sync\n");
  process.stdout.write("6. Quit\n\n");
  const choice = await ask("Choose an option", "1");
  if (choice === "1") return statusCommand(config);
  if (choice === "2") return uploadCommand(config);
  if (choice === "3") return setupCommand(["--replace"], config);
  if (choice === "4") return revokeCommand([], config);
  if (choice === "5") return uninstallCommand([], config);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command = "collect", ...args] = argv;
  const loadedConfig = loadConfig();
  const config = {
    ...loadedConfig,
    includePiSessions:
      hasFlag(args, "--include-pi-sessions") ||
      hasFlag(args, "--include-pi") ||
      loadedConfig.includePiSessions
  };
  await ensureCollectorDirs(config);
  if (shouldCheckForUpdates(command, argv)) await maybePrintUpdateNotice(config, argv);

  if (command === "--help" || command === "-h" || command === "help") return printHelp();
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${COLLECTOR_VERSION}\n`);
    return;
  }
  if (argv.length === 0 || command === "menu") return menuCommand(config);
  if (command === "setup" || command === "add") return setupCommand(args, config);
  if (command === "status") return statusCommand(config);
  if (command === "sync") return syncCommand(args, config);
  if (command === "service") return serviceCommand(args, config);
  if (command === "revoke" || command === "unpair") return revokeCommand(args, config);
  if (command === "uninstall") return uninstallCommand(args, config);
  if (command === "pair") return pairCommand(args, config);
  if (command === "collect") return collectCommand(config);
  if (command === "upload") return uploadCommand(config);
  if (command === "run") return runCommand(args, config);
  throw new Error(`Unknown command: ${command}`);
}

function isDirectCliExecution(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entrypoint);
  } catch {
    return import.meta.url === `file://${entrypoint}`;
  }
}

if (isDirectCliExecution()) {
  main().catch((error: unknown) => {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
