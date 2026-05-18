import { describe, expect, it } from "vitest";
import { safeErrorMessage } from "../src/redact.js";
import { CollectorApiError } from "../src/upload.js";

const secrets = [
  "Bearer collector-token-secret",
  "collector-token-secret",
  "ABCD-1234",
  "pairing-secret-token",
  "/Users/danielmunoz/Repos/private-project",
  "/tmp/secret.txt",
  "me@danmunoz.com",
  "hello world",
  "secret output"
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
      prompt: "hello world",
      response: "secret output",
      command: "cat /tmp/secret.txt"
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
        prompt: "hello world",
        response: "secret output",
        path: "/tmp/secret.txt"
      }
    });

    expectNoSecrets(message);
  });
});
