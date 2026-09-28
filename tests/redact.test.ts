import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redact.js";
import { stderrExcerpt } from "../src/developer-seat.js";

const random = "Zq8xR2mK9vLp4TnW7yHc3BdF6gJs1QaE5uXo0iVk";

describe("redactSecrets", () => {
  it.each([
    ["1Password service-account token", "auth failed for ops_eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9", "ops_eyJ"],
    ["OP_SERVICE_ACCOUNT_TOKEN= form", "env OP_SERVICE_ACCOUNT_TOKEN=abcDEF123secretvalue failed", "abcDEF123secretvalue"],
    ["Bearer header", "Authorization: Bearer abc.def-ghi_123", "abc.def-ghi_123"],
    ["token= pair", "GET /api?token=s3cr3tv4lue&x=1", "s3cr3tv4lue"],
    ["access_token= pair", "access_token=hunter2hunter2", "hunter2hunter2"],
    ["password= pair", "login password=correcthorse failed", "correcthorse"],
    ["Mattermost token after a key", "bot token 8xk3j9q2m7wz5p4r1t6y0u8i3o is invalid", "8xk3j9q2m7wz5p4r1t6y0u8i3o"],
    ["GitHub token", "remote: ghp_abcdefABCDEF1234567890", "ghp_"],
    ["URL userinfo", "fatal: https://user:pw@github.com/x", "user:pw"],
    ["long random string", `unexpected value ${random} in response`, random],
  ])("redacts a %s", (_name, input, secret) => {
    const output = redactSecrets(input);
    expect(output).not.toContain(secret);
    expect(output).toContain("[redacted]");
  });

  it("keeps ordinary error text readable", () => {
    const text = "HTTP 403: /Users/ryan/The Source/indra/state.json failed schema check at /goals/0/outcomes: must have required property 'title'";
    expect(redactSecrets(text)).toBe(text);
  });
});

describe("stderrExcerpt", () => {
  it("redacts before truncating so a secret straddling the cut leaves no fragment", () => {
    const prefix = "x".repeat(100) + " ";
    const excerpt = stderrExcerpt(`${prefix}${random}`, 120);
    expect(excerpt).toBe(`${prefix}[redacted]`);
    expect(excerpt).not.toContain(random.slice(0, 10));
  });
});
