import { describe, expect, it } from "vitest";
import { codexEnvironment } from "../src/codex-runtime.js";

describe("Codex child environment", () => {
  it("drops all unrelated values including credential URLs and proxies", () => {
    expect(codexEnvironment({ PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/tmp/codex", LANG: "en_US.UTF-8", OP_SERVICE_ACCOUNT_TOKEN: "service", INDRA_CHICK_TOKEN: "bot", GITHUB_TOKEN: "github", OPENAI_API_KEY: "api", AWS_SECRET_ACCESS_KEY: "aws", DATABASE_URL: "postgres://secret", REDIS_URL: "redis://secret", PGPASSWORD: "password", HTTPS_PROXY: "https://user:pass@proxy" })).toEqual({ PATH: "/bin", HOME: "/home/test", CODEX_HOME: "/tmp/codex", LANG: "en_US.UTF-8" });
  });
  it("accepts CODEX_HOME only as an absolute local path", () => {
    expect(codexEnvironment({ PATH: "/bin", CODEX_HOME: "relative/path", LC_SECRET: "bad" })).toEqual({ PATH: "/bin" });
  });
});
