import { describe, expect, it, vi } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import {
  getCollectorStatus,
  isCollectorApiError,
  pairCollector,
  revokeCollector,
  serializeAggregateForUpload,
  uploadAggregate
} from "../src/upload.js";
import type { CollectorApiError } from "../src/upload.js";

describe("upload client", () => {
  const snapshot = buildAggregate([], {
    machineId: "mach",
    machineLabel: "Machine",
    codexHomeKind: "default",
    now: new Date("2026-05-15T12:00:00.000Z")
  });

  it("serializes only aggregate allowlist fields", () => {
    const serialized = serializeAggregateForUpload({
      ...snapshot,
      // @ts-expect-error deliberate extra raw field should be dropped.
      raw_prompt: "do not upload"
    });
    expect(serialized).not.toContain("raw_prompt");
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      "schema_version",
      "machine_id",
      "machine_label",
      "generated_at",
      "periods",
      "daily",
      "models",
      "collector"
    ]);
  });

  it("uploads to the collector usage endpoint with bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await uploadAggregate(
      {
        collector_token: "secret-token",
        api_base_url: "https://api.example.test",
        machine_id: "mach",
        machine_label: "Machine",
        upload_interval_minutes: 15
      },
      snapshot,
      fetchMock
    );

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/usage", "https://api.example.test"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret-token" })
      })
    );
  });

  it("exchanges pairing code for credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          upload_interval_minutes: 15
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      pairCollector("https://api.example.test", "ABCD-1234", "Machine", "0.1.0", fetchMock)
    ).resolves.toEqual({
      collector_token: "secret-token",
      api_base_url: "https://api.example.test",
      machine_id: "mach",
      machine_label: "Machine",
      upload_interval_minutes: 15
    });
  });

  it("reads collector status with bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          plugin_status: "active",
          machine_status: "active",
          last_received_at: "2026-05-15T12:00:00.000Z"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      getCollectorStatus(
        {
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          machine_label: "Machine",
          upload_interval_minutes: 15
        },
        fetchMock
      )
    ).resolves.toMatchObject({ plugin_status: "active", machine_status: "active" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/status", "https://api.example.test"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ authorization: "Bearer secret-token" })
      })
    );
  });

  it("revokes the collector with bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, revoked_at: "2026-05-15T12:00:00.000Z" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(
      revokeCollector(
        {
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          machine_label: "Machine",
          upload_interval_minutes: 15
        },
        fetchMock
      )
    ).resolves.toMatchObject({ ok: true, revoked_at: "2026-05-15T12:00:00.000Z" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/collector", "https://api.example.test"),
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ authorization: "Bearer secret-token" })
      })
    );
  });

  it("raises typed collector errors for revoked credentials", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "collector_revoked" }), {
          status: 403,
          headers: { "content-type": "application/json" }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "collector_revoked" }), {
          status: 403,
          headers: { "content-type": "application/json" }
        })
      );

    await expect(
      getCollectorStatus(
        {
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          machine_label: "Machine",
          upload_interval_minutes: 15
        },
        fetchMock
      )
    ).rejects.toMatchObject({
      name: "CollectorApiError",
      operation: "status",
      status: 403,
      code: "collector_revoked"
    } satisfies Partial<CollectorApiError>);

    try {
      await revokeCollector(
        {
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          machine_label: "Machine",
          upload_interval_minutes: 15
        },
        fetchMock
      );
    } catch (error) {
      expect(isCollectorApiError(error, "collector_revoked")).toBe(true);
    }
  });
});
