import type { TokenUsage, UsageEvent } from "./types.js";

interface NormalizeResult {
  event?: UsageEvent;
  malformed: boolean;
  context?: TokenUsageContext;
}

export interface TokenUsageContext {
  currentModel?: string;
  sessionId?: string;
  branchId?: string;
  parentId?: string;
  forkTimestamp?: string;
}

export function mergeTokenUsageContext(
  target: TokenUsageContext,
  update: TokenUsageContext
): void {
  if (update.currentModel) target.currentModel = update.currentModel;
  if (update.sessionId && !target.sessionId) target.sessionId = update.sessionId;
  if (update.branchId && !target.branchId) target.branchId = update.branchId;
  if (update.parentId && !target.parentId) target.parentId = update.parentId;
  if (update.forkTimestamp && !target.forkTimestamp) target.forkTimestamp = update.forkTimestamp;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function booleanOrUnknown(value: unknown): boolean | "unknown" | undefined {
  if (typeof value === "boolean") return value;
  if (value === "unknown") return "unknown";
  return undefined;
}

function priorityTier(value: unknown): "base" | "priority" | "unknown" | undefined {
  if (value === "base" || value === "priority" || value === "unknown") return value;
  if (value === "premium" || value === "priority_tier") return "priority";
  return undefined;
}

function normalizeUsage(raw: Record<string, unknown>): TokenUsage {
  const input = numberField(
    raw.input_tokens ?? raw.inputTokens ?? raw.prompt_tokens ?? raw.promptTokens
  );
  const cached = numberField(
    raw.cached_input_tokens ??
      raw.cachedInputTokens ??
      raw.cache_read_input_tokens ??
      raw.cacheReadInputTokens ??
      raw.cached_tokens ??
      raw.cachedTokens
  );
  const output = numberField(
    raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens ?? raw.completionTokens
  );
  return {
    input_tokens: input,
    cached_input_tokens: Math.min(cached, input),
    output_tokens: output
  };
}

function sessionContext(object: Record<string, unknown>): TokenUsageContext | undefined {
  if (object.type !== "session_meta") return undefined;
  const payload = objectField(object.payload);
  const parentId = stringField(
    payload?.forked_from_id ??
      payload?.forkedFromId ??
      payload?.parent_session_id ??
      payload?.parentSessionId ??
      payload?.parent_id ??
      payload?.parentId ??
      object.parent_id ??
      object.parentId,
    ""
  );
  return {
    sessionId: stringField(
      payload?.session_id ??
        payload?.sessionId ??
        payload?.id ??
        object.session_id ??
        object.sessionId ??
        object.id,
      ""
    ),
    branchId: stringField(payload?.branch_id ?? payload?.branchId ?? object.branch_id, ""),
    parentId,
    forkTimestamp: parentId
      ? stringField(payload?.timestamp ?? object.timestamp ?? object.created_at ?? object.createdAt, "")
      : ""
  };
}

function turnContext(object: Record<string, unknown>): TokenUsageContext | undefined {
  if (object.type !== "turn_context") return undefined;
  const payload = objectField(object.payload);
  const info = objectField(payload?.info);
  const currentModel = stringField(payload?.model ?? info?.model, "");
  return currentModel ? { currentModel } : undefined;
}

export function normalizeTokenUsageRecord(
  record: unknown,
  context: TokenUsageContext = {}
): NormalizeResult {
  if (!record || typeof record !== "object") return { malformed: true };
  const object = record as Record<string, unknown>;

  const contextUpdate = sessionContext(object) ?? turnContext(object);
  if (contextUpdate) return { malformed: false, context: contextUpdate };

  const payload = objectField(object.payload);
  const info = objectField(payload?.info);
  const nestedTokenCount = object.type === "event_msg" && payload?.type === "token_count";
  const hasTotalUsage =
    info?.total_token_usage ??
    info?.totalTokenUsage ??
    object.total_token_usage ??
    object.totalTokenUsage;
  const hasLastUsage =
    info?.last_token_usage ?? info?.lastTokenUsage ?? object.last_token_usage ?? object.lastTokenUsage;
  const usage = hasLastUsage ?? hasTotalUsage ?? object.token_usage ?? object.usage;

  if (!usage || typeof usage !== "object") return { malformed: false };
  const usageObject = usage as Record<string, unknown>;
  const timestampValue = object.timestamp ?? object.created_at ?? object.createdAt ?? object.time;
  const timestamp = new Date(typeof timestampValue === "string" ? timestampValue : Date.now());
  if (Number.isNaN(timestamp.getTime())) return { malformed: true };

  const tokenUsage = normalizeUsage(usageObject);
  const hasUsage =
    tokenUsage.input_tokens > 0 ||
    tokenUsage.cached_input_tokens > 0 ||
    tokenUsage.output_tokens > 0;
  if (!hasUsage) return { malformed: false };

  const event: UsageEvent = {
    ...tokenUsage,
    timestamp,
    model: stringField(
      context.currentModel ??
        info?.model ??
        info?.model_name ??
        payload?.model ??
        usageObject.model ??
        object.model,
      "unknown"
    ),
    session_id: stringField(
      object.session_id ?? object.sessionId ?? object.conversation_id ?? context.sessionId,
      "unknown"
    ),
    record_kind: hasLastUsage ? "delta" : hasTotalUsage ? "cumulative" : "delta"
  };
  event.long_context =
    booleanOrUnknown(
      usageObject.long_context ??
        usageObject.longContext ??
        info?.long_context ??
        info?.longContext ??
        payload?.long_context ??
        object.long_context
    ) ?? false;
  event.priority_tier =
    priorityTier(
      usageObject.priority_tier ??
        usageObject.priorityTier ??
        info?.priority_tier ??
        info?.priorityTier ??
        payload?.priority_tier ??
        object.priority_tier
    ) ?? "base";
  const branchId = stringField(object.branch_id ?? object.branchId ?? context.branchId, "");
  const parentId = stringField(object.parent_id ?? object.parentId ?? context.parentId, "");
  if (branchId) event.branch_id = branchId;
  if (parentId) event.parent_id = parentId;
  if (nestedTokenCount && event.session_id === "unknown" && context.sessionId) {
    event.session_id = context.sessionId;
  }
  return { malformed: false, event };
}
