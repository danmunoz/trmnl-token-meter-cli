import { setTimeout as delay } from "node:timers/promises";
import { normalizeApiBaseUrl } from "./config.js";
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

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const RETRY_LIMIT_BY_OPERATION: Record<CollectorApiError["operation"], number> = {
  pair: 0,
  upload: 2,
  status: 2,
  revoke: 2
};

const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 425 || status === 429 || status >= 500;

const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError" || error.name === "TypeError";
};

const requestTimeoutMs = (): number => {
  const raw = process.env.TRMNL_TOKEN_METER_REQUEST_TIMEOUT_MS;
  const value = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_REQUEST_TIMEOUT_MS;
};

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

async function fetchWithPolicy(
  operation: CollectorApiError["operation"],
  url: URL,
  init: RequestInit,
  fetchImpl: typeof fetch
): Promise<Response> {
  const retryLimit = RETRY_LIMIT_BY_OPERATION[operation];

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timeoutMs = requestTimeoutMs();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      if (!response.ok && isRetryableStatus(response.status) && attempt < retryLimit) {
        await delay(250 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      if (controller.signal.aborted) {
        if (attempt < retryLimit) {
          await delay(250 * (attempt + 1));
          continue;
        }
        throw new Error(`${operation} request timed out after ${timeoutMs}ms`);
      }
      if (attempt < retryLimit && isRetryableError(error)) {
        await delay(250 * (attempt + 1));
        continue;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
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
  const url = new URL("/api/v1/usage", normalizeApiBaseUrl(credential.api_base_url));
  const response = await fetchWithPolicy(
    "upload",
    url,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.collector_token}`,
        "content-type": "application/json"
      },
      body: serializeAggregateForUpload(snapshot)
    },
    fetchImpl
  );

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
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const expectedOrigin = new URL(normalizedApiBaseUrl).origin;
  const url = new URL("/api/v1/pair", normalizedApiBaseUrl);
  const response = await fetchWithPolicy(
    "pair",
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairing_code: pairingCode,
        machine_label: machineLabel,
        collector_version: collectorVersion
      })
    },
    fetchImpl
  );
  const body = (await responseBody(response)) as Partial<CollectorCredential>;
  if (!response.ok) {
    throwCollectorError("pair", response, body);
  }
  if (!body.collector_token || !body.api_base_url || !body.machine_id) {
    throw new Error("Pairing response missing credential fields");
  }
  return {
    collector_token: body.collector_token,
    api_base_url: normalizeApiBaseUrl(body.api_base_url, { expectedOrigin }),
    machine_id: body.machine_id,
    machine_label: machineLabel,
    upload_interval_minutes: body.upload_interval_minutes ?? 15
  };
}

export async function getCollectorStatus(
  credential: CollectorCredential,
  fetchImpl: typeof fetch = fetch
): Promise<CollectorStatus> {
  const response = await fetchWithPolicy(
    "status",
    new URL("/api/v1/status", normalizeApiBaseUrl(credential.api_base_url)),
    {
      method: "GET",
      headers: { authorization: `Bearer ${credential.collector_token}` }
    },
    fetchImpl
  );
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
  const response = await fetchWithPolicy(
    "revoke",
    new URL("/api/v1/collector", normalizeApiBaseUrl(credential.api_base_url)),
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${credential.collector_token}` }
    },
    fetchImpl
  );
  const body = (await responseBody(response)) as { ok?: boolean; revoked_at?: unknown };
  if (!response.ok) {
    throwCollectorError("revoke", response, body);
  }
  return {
    ok: body.ok === true,
    revoked_at: typeof body.revoked_at === "string" ? body.revoked_at : null
  };
}
