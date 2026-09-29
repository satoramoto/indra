import { describe, expect, it } from "vitest";
import { isSecretEnvName, redactSecrets } from "../src/redact.js";
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

  it.each([
    ["GitHub prefixes", "ghp_fixture gho_fixture ghu_fixture ghs_fixture ghr_fixture github_pat_fixture", "[redacted] [redacted] [redacted] [redacted] [redacted] [redacted]"],
    ["1Password alphabet", "failed: ops_fixture+/=.- next", "failed: [redacted] next"],
    ["URL userinfo", "https://user:fixture@example.test/path?x=1", "https://[redacted]@example.test/path?x=1"],
    ["authorization case and whitespace", "bEaReR\tfixture.value Basic Zml4dHVyZQ==", "bEaReR\t[redacted] Basic [redacted]"],
    ["key spelling and delimiters", 'api-key="fixture-one", passwd=fixture-two; SECRET:fixture-three&x=1', 'api-key="[redacted]", passwd=[redacted]; SECRET:[redacted]&x=1'],
    ["JSON pairs", '{"access_token":"fixture-one","apiKey":"fixture-two"}', '{"access_token":"[redacted]","apiKey":"[redacted]"}'],
    ["Mattermost key context", "token 8xk3j9q2m7wz5p4r1t6y0u8i3o / 8xk3j9q2m7wz5p4r1t6y0u8i3o", "token [redacted] / 8xk3j9q2m7wz5p4r1t6y0u8i3o"],
    ["mixed alphanumeric threshold", `${"a1".repeat(15)} ${"a1".repeat(16)}`, `${"a1".repeat(15)} [redacted]`],
    ["letters and digits alone", `${"a".repeat(40)} ${"1".repeat(40)}`, `${"a".repeat(40)} ${"1".repeat(40)}`],
    ["already redacted text", "token=[redacted] Bearer [redacted]", "token=[redacted] Bearer [redacted]"],
  ])("preserves the exact redaction of %s", (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
    expect(redactSecrets(expected)).toBe(expected);
  });
});

describe("isSecretEnvName", () => {
  it.each(["TOKEN", "access_token", "Password", "DB_PASSWD", "clientSecret", "ANTHROPIC_API_KEY", "OpenAI_ApiKey", "MAX_TOKENS"])("matches the existing Claude filter for %s", (name) => {
    expect(isSecretEnvName(name)).toBe(true);
    // Filtering a sequence of names must not inherit regexp match state.
    expect(isSecretEnvName(name)).toBe(true);
  });

  it.each(["PATH", "HOME", "CODEX_HOME", "OP_SESSION_owner", "API-KEY", "MONKEY", "SESSION"])("leaves %s to the caller's environment policy", (name) => {
    expect(isSecretEnvName(name)).toBe(false);
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
