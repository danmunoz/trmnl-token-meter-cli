const SECRET_KEYS = [
  "authorization",
  "collector_token",
  "pairing_code",
  "token",
  "secret",
  "password",
  "api_key"
];

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /([A-Za-z0-9_]*token[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
  /([A-Za-z0-9_]*secret[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^"',\s}]+/gi,
  /([A-Z0-9]{4})-[A-Z0-9]{4}/gi,
  /\/Users\/[^"',\s}]+/g,
  /\/home\/[^"',\s}]+/g,
  /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,120}/gi,
  /CANARY_[A-Z0-9_]+/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /\b(?:sk|sess|ghp)_[A-Za-z0-9]{8,}\b/g
];

export function redactText(input: unknown): string {
  let text = typeof input === "string" ? input : JSON.stringify(input);
  if (!text) return "";
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix: string | undefined) =>
      prefix ? `${prefix}[REDACTED]` : "[REDACTED]"
    );
  }
  return text;
}

export function redactObject<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactObject(item)) as T;
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.some((secretKey) => key.toLowerCase().includes(secretKey))) {
        output[key] = "[REDACTED]";
      } else if (typeof item === "string") {
        output[key] = redactText(item);
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
  return redactText(error);
}
