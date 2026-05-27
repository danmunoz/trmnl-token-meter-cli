import { describe, expect, it, vi } from "vitest";
import { buildAggregate } from "../src/aggregate.js";
import { safeErrorMessage } from "../src/redact.js";
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
      source_summaries: [],
      // @ts-expect-error deliberate extra raw field should be dropped.
      raw_prompt: "do not upload"
    });
    expect(serialized).not.toContain("raw_prompt");
    expect(serialized).not.toContain("input_tokens");
    expect(serialized).not.toContain("cached_input_tokens");
    expect(serialized).not.toContain("output_tokens");
    expect(serialized).not.toContain("cache_read_input_tokens");
    expect(serialized).not.toContain("cache_creation_input_tokens");
    expect(serialized).not.toContain("token_breakdown");
    expect(Object.keys(JSON.parse(serialized))).toEqual([
      "schema_version",
      "machine_id",
      "machine_label",
      "generated_at",
      "periods",
      "daily",
      "models",
      "source_summaries",
      "collector"
    ]);
    expect(JSON.parse(serialized).periods).toHaveProperty("last_14_days");
    expect(JSON.parse(serialized).daily).toHaveLength(15);
    const serializedPayload = JSON.parse(serialized);
    expect(serializedPayload.collector).toMatchObject({
      version: serializedPayload.collector.version,
      supported_providers: ["codex", "opencode", "claude"],
      enabled_providers: ["codex"],
      provider_statuses: []
    });
  });

  it("uploads to the collector usage endpoint with bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(
      uploadAggregate(
        {
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          machine_label: "Machine",
          upload_interval_minutes: 60
        },
        snapshot,
        fetchMock
      )
    ).resolves.toMatchObject({
      ok: true,
      next_upload_after_seconds: null
    });

    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/api/v1/usage", "https://api.example.test"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer secret-token" })
      })
    );
  });

  it("parses enabled_providers from upload responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          next_upload_after_seconds: 240,
          enabled_providers: ["codex", "opencode", "invalid"]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      uploadAggregate(
        {
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          machine_label: "Machine",
          upload_interval_minutes: 60
        },
        snapshot,
        fetchMock
      )
    ).resolves.toMatchObject({
      ok: true,
      enabled_providers: ["codex", "opencode"],
      next_upload_after_seconds: 240
    });
  });

  it("parses empty enabled_providers list as empty", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          next_upload_after_seconds: 120,
          enabled_providers: []
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      uploadAggregate(
        {
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          machine_label: "Machine",
          upload_interval_minutes: 60
        },
        snapshot,
        fetchMock
      )
    ).resolves.toMatchObject({
      ok: true,
      enabled_providers: [],
      next_upload_after_seconds: 120
    });
  });

  it("parses invalid-only enabled_providers as null", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          enabled_providers: ["future", 42]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      uploadAggregate(
        {
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          machine_label: "Machine",
          upload_interval_minutes: 60
        },
        snapshot,
        fetchMock
      )
    ).resolves.toMatchObject({
      ok: true,
      enabled_providers: null
    });
  });

  it("exchanges pairing code for credentials", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          upload_interval_minutes: 60
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
      upload_interval_minutes: 60
    });
  });

  it("defaults the pairing interval to 60 minutes when the backend omits it", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach"
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
      upload_interval_minutes: 60
    });
  });

  it("rejects pairing responses that change the API origin", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          collector_token: "secret-token",
          api_base_url: "https://evil.test",
          machine_id: "mach",
          upload_interval_minutes: 60
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      pairCollector("https://api.example.test", "ABCD-1234", "Machine", "0.1.0", fetchMock)
    ).rejects.toThrow("unexpected API origin");
  });

  it("reads collector status with bearer auth", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          plugin_status: "active",
          machine_status: "active",
          last_received_at: "2026-05-15T12:00:00.000Z",
          upload_interval_minutes: 240
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
          upload_interval_minutes: 60
        },
        fetchMock
      )
    ).resolves.toMatchObject({
      plugin_status: "active",
      machine_status: "active",
      upload_interval_minutes: 240
    });
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
          upload_interval_minutes: 60
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
          upload_interval_minutes: 60
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
          upload_interval_minutes: 60
        },
        fetchMock
      );
    } catch (error) {
      expect(isCollectorApiError(error, "collector_revoked")).toBe(true);
    }
  });

  it("redacts upload failure details in CLI-safe error messages", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "collector_unauthorized",
          authorization: "Bearer secret-token",
          collector_token: "secret-token",
          pairing_code: "ABCD-1234",
          detail:
            "failed for me@danmunoz.com at /Users/danielmunoz/Repos/private-project with CANARY_PROMPT_DO_NOT_UPLOAD"
        }),
        { status: 401, headers: { "content-type": "application/json" } }
      )
    );

    await expect(
      uploadAggregate(
        {
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          machine_label: "Machine",
          upload_interval_minutes: 60
        },
        snapshot,
        fetchMock
      )
    ).rejects.toSatisfy((error: unknown) => {
      const message = safeErrorMessage(error);
      return (
        !message.includes("Bearer secret-token") &&
        !message.includes("secret-token") &&
        !message.includes("ABCD-1234") &&
        !message.includes("me@danmunoz.com") &&
        !message.includes("/Users/danielmunoz/Repos/private-project") &&
        !message.includes("CANARY_PROMPT_DO_NOT_UPLOAD")
      );
    });
  });

  it("times out stalled uploads", async () => {
    process.env.TRMNL_TOKEN_METER_REQUEST_TIMEOUT_MS = "25";
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        })
    );

    try {
      await expect(
        uploadAggregate(
          {
            collector_token: "secret-token",
            api_base_url: "https://api.example.test",
            machine_id: "mach",
            machine_label: "Machine",
            upload_interval_minutes: 60
          },
          snapshot,
          fetchMock
        )
      ).rejects.toThrow("upload request timed out");
    } finally {
      delete process.env.TRMNL_TOKEN_METER_REQUEST_TIMEOUT_MS;
    }
  });

  it("returns next upload timing from successful uploads", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, next_upload_after_seconds: 14400 }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );

    await expect(
      uploadAggregate(
        {
          collector_token: "secret-token",
          api_base_url: "https://api.example.test",
          machine_id: "mach",
          machine_label: "Machine",
          upload_interval_minutes: 60
        },
        snapshot,
        fetchMock
      )
    ).resolves.toMatchObject({
      ok: true,
      next_upload_after_seconds: 14400
    });
  });
});
