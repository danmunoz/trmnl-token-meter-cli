import { describe, expect, it } from "vitest";
import { renderStatusSummary } from "../src/status-ui.js";

const formatDate = (value: string | null | undefined) => value ?? "Never";

describe("status UI", () => {
  it("renders a structured paired status summary", () => {
    expect(
      renderStatusSummary(
        {
          credential: {
            collector_token: "secret",
            api_base_url: "https://api.example.test",
            machine_id: "mach_123",
            machine_label: "Office Mac",
            upload_interval_minutes: 60
          },
          remoteStatus: {
            ok: true,
            plugin_status: "active",
            machine_status: "healthy",
            last_received_at: "2026-05-19T10:00:00.000Z"
          },
          remoteError: null,
          revoked: false,
          localService: {
            installed: true,
            method: "launchd",
            runner: "/tmp/runner.js",
            runner_version: "0.1.1",
            current_version: "0.1.1",
            interval_minutes: 60,
            last_sync_at: null,
            last_status: null
          },
          syncState: {
            last_sync_at: "2026-05-19T09:55:00.000Z",
            last_status: "success"
          },
          sources: [
            { kind: "codex_sessions", enabled: true, status: "read", record_count: 2 },
            { kind: "opencode_sqlite", enabled: true, status: "missing" },
            { kind: "claude_projects", enabled: true, status: "read", record_count: 1 }
          ]
        },
        formatDate
      )
    ).toMatchInlineSnapshot(`
      "Pairing
        Meter: paired as Office Mac (mach_123)

      Server
        Server: active plugin, healthy device
        Last server sync: 2026-05-19T10:00:00.000Z

      Sync
        Configured upload interval: every 1 hour
        Background runner version: 0.1.1 (matches current CLI)
        Background sync: launchd every 60 minutes
        Last local sync: 2026-05-19T09:55:00.000Z

      Sources
        Codex sessions: read (2 records)
        OpenCode SQLite: missing
        Claude projects: read (1 record)"
    `);
  });

  it("renders recovery guidance for revoked meters", () => {
    expect(
      renderStatusSummary(
        {
          credential: {
            collector_token: "secret",
            api_base_url: "https://api.example.test",
            machine_id: "mach_123",
            machine_label: "Office Mac",
            upload_interval_minutes: 60
          },
          remoteStatus: null,
          remoteError: null,
          revoked: true,
          localService: {
            installed: false,
            method: null,
            runner: null,
            runner_version: null,
            current_version: "0.1.1",
            interval_minutes: null,
            last_sync_at: null,
            last_status: null
          },
          syncState: {
            last_sync_at: null,
            last_status: "error",
            last_error: "collector_revoked"
          }
        },
        formatDate
      )
    ).toContain("Action: run `trmnl-token-meter add` to pair again");
  });

  it("renders a version mismatch warning for the installed background runner", () => {
    expect(
      renderStatusSummary(
        {
          credential: {
            collector_token: "secret",
            api_base_url: "https://api.example.test",
            machine_id: "mach_123",
            machine_label: "Office Mac",
            upload_interval_minutes: 60
          },
          remoteStatus: null,
          remoteError: null,
          revoked: false,
          localService: {
            installed: true,
            method: "launchd",
            runner: "/tmp/runner.js",
            runner_version: "0.1.0",
            current_version: "0.1.1",
            interval_minutes: 60,
            last_sync_at: null,
            last_status: null
          },
          syncState: {
            last_sync_at: "2026-05-19T09:55:00.000Z",
            last_status: "success"
          }
        },
        formatDate
      )
    ).toContain("Action: run the newer CLI once to refresh the installed background runner");
  });
});
