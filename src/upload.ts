import { safeErrorMessage } from "./redact.js";
import type { AggregateSnapshot, CollectorCredential } from "./types.js";

const allowedTopLevelKeys = [
  "schema_version",
  "machine_id",
  "machine_label",
  "generated_at",
  "periods",
  "daily",
  "models",
  "collector"
] as const;

export interface CollectorStatus {
  ok: boolean;
  plugin_status: string;
  machine_status: string;
  last_received_at: string | null;
}

export type CollectorErrorCode =
  | "collector_revoked"
  | "collector_unauthorized"
  | "plugin_inactive"
  | "invalid_request"
  | "invalid_schema"
  | "stale_schema_version"
  | "raw_content_field"
  | "unknown";

export class CollectorApiError extends Error {
  constructor(
    readonly operation: "pair" | "upload" | "status" | "revoke",
    readonly status: number,
    readonly code: CollectorErrorCode,
    readonly body: unknown
  ) {
    super(`${operation} failed with ${status}: ${safeErrorMessage(body)}`);
    this.name = "CollectorApiError";
  }
}

function errorCodeFromBody(body: unknown): CollectorErrorCode {
  if (!body || typeof body !== "object") return "unknown";
  const error = (body as Record<string, unknown>).error;
  if (
    error === "collector_revoked" ||
    error === "collector_unauthorized" ||
    error === "plugin_inactive" ||
    error === "invalid_request" ||
    error === "invalid_schema" ||
    error === "stale_schema_version" ||
    error === "raw_content_field"
  ) {
    return error;
  }
  return "unknown";
}

function isJsonResponse(response: Response): boolean {
  return response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
}

async function responseBody(response: Response): Promise<unknown> {
  if (isJsonResponse(response)) return response.json().catch(() => ({}));
  const text = await response.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return text;
  }
}

function throwCollectorError(
  operation: "pair" | "upload" | "status" | "revoke",
  response: Response,
  body: unknown
): never {
  throw new CollectorApiError(operation, response.status, errorCodeFromBody(body), body);
}

export function isCollectorApiError(error: unknown, code?: CollectorErrorCode): error is CollectorApiError {
  return error instanceof CollectorApiError && (!code || error.code === code);
}

export function serializeAggregateForUpload(snapshot: AggregateSnapshot): string {
  const allowlisted: Record<string, unknown> = {};
  for (const key of allowedTopLevelKeys) {
    allowlisted[key] = snapshot[key];
  }
  return JSON.stringify(allowlisted);
}

export async function uploadAggregate(
  credential: CollectorCredential,
  snapshot: AggregateSnapshot,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const url = new URL("/api/v1/usage", credential.api_base_url);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential.collector_token}`,
      "content-type": "application/json"
    },
    body: serializeAggregateForUpload(snapshot)
  });

  const body = await responseBody(response);

  if (!response.ok) {
    throwCollectorError("upload", response, body);
  }
  return body;
}

export async function pairCollector(
  apiBaseUrl: string,
  pairingCode: string,
  machineLabel: string,
  collectorVersion: string,
  fetchImpl: typeof fetch = fetch
): Promise<CollectorCredential> {
  const url = new URL("/api/v1/pair", apiBaseUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      pairing_code: pairingCode,
      machine_label: machineLabel,
      collector_version: collectorVersion
    })
  });
  const body = (await responseBody(response)) as Partial<CollectorCredential>;
  if (!response.ok) {
    throwCollectorError("pair", response, body);
  }
  if (!body.collector_token || !body.api_base_url || !body.machine_id) {
    throw new Error("Pairing response missing credential fields");
  }
  return {
    collector_token: body.collector_token,
    api_base_url: body.api_base_url,
    machine_id: body.machine_id,
    machine_label: machineLabel,
    upload_interval_minutes: body.upload_interval_minutes ?? 15
  };
}

export async function getCollectorStatus(
  credential: CollectorCredential,
  fetchImpl: typeof fetch = fetch
): Promise<CollectorStatus> {
  const response = await fetchImpl(new URL("/api/v1/status", credential.api_base_url), {
    method: "GET",
    headers: { authorization: `Bearer ${credential.collector_token}` }
  });
  const body = (await responseBody(response)) as Partial<CollectorStatus>;
  if (!response.ok) {
    throwCollectorError("status", response, body);
  }
  return {
    ok: body.ok === true,
    plugin_status: String(body.plugin_status ?? "unknown"),
    machine_status: String(body.machine_status ?? "unknown"),
    last_received_at: typeof body.last_received_at === "string" ? body.last_received_at : null
  };
}

export async function revokeCollector(
  credential: CollectorCredential,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; revoked_at: string | null }> {
  const response = await fetchImpl(new URL("/api/v1/collector", credential.api_base_url), {
    method: "DELETE",
    headers: { authorization: `Bearer ${credential.collector_token}` }
  });
  const body = (await responseBody(response)) as { ok?: boolean; revoked_at?: unknown };
  if (!response.ok) {
    throwCollectorError("revoke", response, body);
  }
  return {
    ok: body.ok === true,
    revoked_at: typeof body.revoked_at === "string" ? body.revoked_at : null
  };
}
