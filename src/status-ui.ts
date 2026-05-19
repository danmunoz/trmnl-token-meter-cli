import { note } from "@clack/prompts";
import type { ServiceStatus, SyncState } from "./service.js";
import type { CollectorCredential } from "./types.js";
import type { CollectorStatus } from "./upload.js";

interface StatusViewData {
  credential: CollectorCredential | null;
  remoteStatus: CollectorStatus | null;
  remoteError: string | null;
  revoked: boolean;
  localService: ServiceStatus;
  syncState: SyncState | null;
}

function serviceLine(status: ServiceStatus): string {
  if (!status.installed) return "Background sync: not installed";
  return `Background sync: ${status.method} every ${status.interval_minutes ?? "?"} minutes`;
}

function intervalLabel(minutes: number): string {
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function runnerVersionLine(status: ServiceStatus): string | null {
  if (!status.installed) return null;
  if (!status.runner_version) return `Background runner version: unknown (current CLI ${status.current_version})`;
  if (status.runner_version === status.current_version) {
    return `Background runner version: ${status.runner_version} (matches current CLI)`;
  }
  return `Background runner version: ${status.runner_version} (current CLI ${status.current_version})`;
}

function addSection(lines: string[], title: string, rows: string[]): void {
  if (lines.length > 0) lines.push("");
  lines.push(title);
  for (const row of rows) {
    lines.push(`  ${row}`);
  }
}

export function renderStatusSummary(
  data: StatusViewData,
  formatDate: (value: string | null | undefined) => string
): string {
  const lines: string[] = [];

  if (!data.credential) {
    addSection(lines, "Pairing", [
      "Meter: not paired",
      "Action: run `trmnl-token-meter setup` or `trmnl-token-meter add`"
    ]);
  } else {
    addSection(lines, "Pairing", [
      `Meter: paired as ${data.credential.machine_label} (${data.credential.machine_id})`
    ]);
  }

  if (data.credential) {
    if (data.remoteStatus) {
      addSection(lines, "Server", [
        `Server: ${data.remoteStatus.plugin_status} plugin, ${data.remoteStatus.machine_status} device`,
        `Last server sync: ${formatDate(data.remoteStatus.last_received_at)}`
      ]);
    } else if (data.revoked) {
      addSection(lines, "Server", [
        "Server: revoked",
        "Action: run `trmnl-token-meter add` to pair again, or `trmnl-token-meter uninstall` to remove local credentials"
      ]);
    } else if (data.remoteError) {
      addSection(lines, "Server", [`Server: ${data.remoteError}`]);
    }
  }

  const syncRows = [
    ...(data.credential
      ? [`Configured upload interval: every ${intervalLabel(data.credential.upload_interval_minutes)}`]
      : []),
    serviceLine(data.localService),
    `Last local sync: ${formatDate(data.syncState?.last_sync_at)}`
  ];
  const runnerVersion = runnerVersionLine(data.localService);
  if (runnerVersion) syncRows.splice(1, 0, runnerVersion);
  if (data.syncState?.last_status === "error") {
    syncRows.push(`Last sync error: ${data.syncState.last_error ?? "Unknown error"}`);
  }
  if (
    data.localService.installed &&
    data.localService.runner_version &&
    data.localService.runner_version !== data.localService.current_version
  ) {
    syncRows.push("Action: run the newer CLI once to refresh the installed background runner");
  }
  addSection(lines, "Sync", syncRows);

  return lines.join("\n");
}

export function printStatusSummary(
  data: StatusViewData,
  formatDate: (value: string | null | undefined) => string
): void {
  const summary = renderStatusSummary(data, formatDate);
  if (process.stdout.isTTY) {
    note(summary, "TRMNL Token Meter Status");
    return;
  }
  process.stdout.write(`TRMNL Token Meter Status\n\n${summary}\n`);
}
