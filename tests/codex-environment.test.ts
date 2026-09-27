import { describe, expect, it } from "vitest";
import { codexEnvironment } from "../src/codex-runtime.js";

describe("Codex child environment", () => {
  it("drops planning, service account, and common credential values while preserving login paths", () => {
    expect(codexEnvironment({ PATH: "/bin", CODEX_HOME: "/tmp/codex", OP_SERVICE_ACCOUNT_TOKEN: "service", INDRA_CHICK_TOKEN: "bot", GITHUB_TOKEN: "github", OPENAI_API_KEY: "api", AWS_SECRET_ACCESS_KEY: "aws", HTTPS_PROXY: "proxy" })).toEqual({ PATH: "/bin", CODEX_HOME: "/tmp/codex", HTTPS_PROXY: "proxy" });
  });
});
