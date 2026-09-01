import { note } from "@clack/prompts";
import type { ServiceStatus, SyncState } from "./service.js";
import type { CollectorCredential, LocalUsageSourceKind, LocalUsageSourceStatus } from "./types.js";
import type { CollectorStatus } from "./upload.js";

interface StatusViewData {
  credential: CollectorCredential | null;
  remoteStatus: CollectorStatus | null;
  remoteError: string | null;
  revoked: boolean;
  localService: ServiceStatus;
  syncState: SyncState | null;
  sources?: LocalUsageSourceStatus[];
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

function serviceHealthLine(status: ServiceStatus): string | null {
  if (!status.installed || status.health === "healthy" || status.health === "unknown") return null;
  switch (status.health) {
    case "repair_required":
      return "Background sync health: needs migration to a stable runtime launcher";
    case "runtime_unavailable":
      return "Background sync health: configured runtime is unavailable";
    case "crash_loop":
      return "Background sync health: scheduler is crash-looping";
  }
}

function addSection(lines: string[], title: string, rows: string[]): void {
  if (lines.length > 0) lines.push("");
  lines.push(title);
  for (const row of rows) {
    lines.push(`  ${row}`);
  }
}

function sourceLabel(kind: LocalUsageSourceKind): string {
  switch (kind) {
    case "codex_sessions":
      return "Codex sessions";
    case "codex_archived_sessions":
      return "Codex archived sessions";
    case "codex_priority_sqlite":
      return "Codex priority evidence";
    case "pi_sessions":
      return "Pi sessions";
    case "opencode_sqlite":
      return "OpenCode SQLite";
    case "claude_projects":
      return "Claude projects";
  }
}

function sourceStatusLabel(source: LocalUsageSourceStatus): string {
  if (source.status !== "read" || source.record_count === undefined) return source.status;
  const records = source.record_count === 1 ? "record" : "records";
  return `${source.status} (${source.record_count} ${records})`;
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
  const health = serviceHealthLine(data.localService);
  if (health) {
    syncRows.push(health);
    syncRows.push("Action: run `trmnl-token-meter service repair` to rebuild background sync");
  }
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

  if (data.sources && data.sources.length > 0) {
    addSection(
      lines,
      "Sources",
      data.sources.map((source) => `${sourceLabel(source.kind)}: ${sourceStatusLabel(source)}`)
    );
  }

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
