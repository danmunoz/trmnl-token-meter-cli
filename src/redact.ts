const REDACTED = "[REDACTED]";

const SECRET_KEYS = [
  "authorization",
  "collector_token",
  "pairing_code",
  "token",
  "secret",
  "password",
  "api_key"
];

const CONTENT_KEYS = [
  "prompt",
  "response",
  "command",
  "content",
  "diff",
  "output",
  "tool_output",
  "path",
  "cwd",
  "file",
  "repo",
  "repository",
  "sql"
];

const SAFE_OBJECT_STRING_KEYS = new Set([
  "code",
  "error",
  "kind",
  "machine_status",
  "message",
  "name",
  "plugin_status",
  "reason",
  "status",
  "type"
]);

const SAFE_IDENTIFIER_PATTERN = /^[a-z0-9_.:-]{1,80}$/i;

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /([A-Za-z0-9_]*token[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
  /([A-Za-z0-9_]*secret[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
  /([A-Z0-9]{4})-[A-Z0-9]{4}/gi,
  /(^|[\s"'(])\/(?:[^/\s"'(){}]+\/)+[^/\s"'(){}]+/gm,
  /\b[A-Za-z]:\\(?:[^\\\s"'(){}]+\\)+[^\\\s"'(){}]+\b/g,
  /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,120}/gi,
  /CANARY_[A-Z0-9_]+/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b(?:sk|sess|ghp)_[A-Za-z0-9]{8,}\b/g
];

const isSensitiveKey = (key: string): boolean => {
  const lower = key.toLowerCase();
  return (
    SECRET_KEYS.some((secretKey) => lower.includes(secretKey)) ||
    CONTENT_KEYS.some((contentKey) => lower.includes(contentKey))
  );
};

export function redactText(input: unknown): string {
  let text = typeof input === "string" ? input : JSON.stringify(input);
  if (!text) return "";
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix: string | undefined) =>
      prefix ? `${prefix}${REDACTED}` : REDACTED
    );
  }
  return text;
}

function sanitizeObjectString(key: string, value: string): string {
  const redacted = redactText(value);
  if (redacted !== value) return redacted;
  if (SAFE_OBJECT_STRING_KEYS.has(key.toLowerCase()) && SAFE_IDENTIFIER_PATTERN.test(value)) {
    return value;
  }
  if (SAFE_IDENTIFIER_PATTERN.test(value)) return value;
  return REDACTED;
}

export function redactObject<T>(value: T): T {
  if (typeof value === "string") {
    return redactText(value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        output[key] = REDACTED;
      } else if (typeof item === "string") {
        output[key] = sanitizeObjectString(key, item);
      } else {
        output[key] = redactObject(item);
      }
    }
    return output as T;
  }
  return value;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactText(error.message);
  if (error && typeof error === "object") return JSON.stringify(redactObject(error));
  return redactText(error);
}
