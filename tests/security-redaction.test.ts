import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "../src/redact.js";
import { CollectorApiError } from "../src/upload.js";

const secrets = [
  "Bearer collector-token-secret",
  "collector-token-secret",
  "ABCD-1234",
  "pairing-secret-token",
  "/Users/danielmunoz/Repos/private-project",
  "me@danmunoz.com",
  "CANARY_PROMPT_DO_NOT_UPLOAD",
  "CANARY_RESPONSE_DO_NOT_UPLOAD"
];

function expectNoSecrets(message: string): void {
  for (const secret of secrets) {
    expect(message).not.toContain(secret);
  }
  expect(message).toContain("[REDACTED]");
}

describe("security redaction", () => {
  it("redacts failed API error messages before CLI logging", () => {
    const error = new CollectorApiError("upload", 401, "collector_unauthorized", {
      error: "collector_unauthorized",
      authorization: "Bearer collector-token-secret",
      collector_token: "collector-token-secret",
      pairing_code: "ABCD-1234",
      detail:
        "collector_token=pairing-secret-token for me@danmunoz.com at /Users/danielmunoz/Repos/private-project",
      prompt: "CANARY_PROMPT_DO_NOT_UPLOAD",
      response: "CANARY_RESPONSE_DO_NOT_UPLOAD"
    });

    expectNoSecrets(error.message);
    expectNoSecrets(safeErrorMessage(error));
  });

  it("redacts serialized error-shaped objects before persistence", () => {
    const message = safeErrorMessage({
      name: "CollectorApiError",
      message:
        "upload failed: Bearer collector-token-secret ABCD-1234 me@danmunoz.com /Users/danielmunoz/Repos/private-project",
      body: {
        collector_token: "collector-token-secret",
        pairing_code: "ABCD-1234",
        raw: "CANARY_PROMPT_DO_NOT_UPLOAD CANARY_RESPONSE_DO_NOT_UPLOAD"
      }
    });

    expectNoSecrets(message);
  });
});
