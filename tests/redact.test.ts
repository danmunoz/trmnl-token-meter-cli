import { describe, expect, it } from "vitest";
import { redactObject, redactText, safeErrorMessage } from "../src/redact.js";

describe("collector redaction", () => {
  it("redacts bearer tokens, pairing codes, and local paths", () => {
    const text =
      "Authorization: Bearer collector-secret ABCD-1234 /Users/danielmunoz/Repos/private token=abc123";
    const redacted = redactText(text);

    expect(redacted).not.toContain("collector-secret");
    expect(redacted).not.toContain("ABCD-1234");
    expect(redacted).not.toContain("/Users/danielmunoz");
    expect(redacted).not.toContain("abc123");
  });

  it("redacts secret-shaped object keys recursively", () => {
    const redacted = redactObject({
      collector_token: "secret",
      nested: { api_key: "key", message: "Bearer token-value" }
    });

    expect(redacted).toEqual({
      collector_token: "[REDACTED]",
      nested: { api_key: "[REDACTED]", message: "[REDACTED]" }
    });
  });

  it("returns safe error messages", () => {
    expect(safeErrorMessage(new Error("Bearer secret-token"))).not.toContain("secret-token");
  });

  it("redacts local source canaries and raw row details", () => {
    const text = [
      "/Users/danielmunoz/Repos/private-project",
      "/home/daniel/private-project",
      "SELECT * FROM logs WHERE prompt = 'CANARY_PROMPT_DO_NOT_UPLOAD'",
      "response=CANARY_RESPONSE_DO_NOT_UPLOAD",
      "cat /Users/danielmunoz/.ssh/id_rsa",
      "cookie=CANARY_COOKIE_DO_NOT_UPLOAD",
      "sk_canarysecret123456"
    ].join(" ");

    const redacted = redactText(text);
    expect(redacted).not.toContain("/Users/danielmunoz");
    expect(redacted).not.toContain("/home/daniel");
    expect(redacted).not.toContain("SELECT * FROM logs");
    expect(redacted).not.toContain("CANARY_PROMPT_DO_NOT_UPLOAD");
    expect(redacted).not.toContain("CANARY_RESPONSE_DO_NOT_UPLOAD");
    expect(redacted).not.toContain("CANARY_COOKIE_DO_NOT_UPLOAD");
    expect(redacted).not.toContain("sk_canarysecret123456");
  });
});
