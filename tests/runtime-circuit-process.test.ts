import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CodexRuntime } from "../src/codex-runtime.js";
import { ClaudeRuntime } from "../src/claude-runtime.js";
import { AgentRunError } from "../src/runtime-facts.js";
import { listProcesses } from "../src/process-tree.js";

it.each(["codex", "claude"] as const)("live %s usage cancellation ends newly detached tool descendants", async (engine) => {
  const dir = await mkdtemp(join(tmpdir(), "indra-runtime-circuit-"));
  const pidFile = join(dir, "tool.pid"); const schema = join(dir, "schema.json");
  const id = "0199a213-81c0-7800-8aa1-bbab2a035a53";
  const controller = new AbortController(); let pid = 0;
  try {
    await writeFile(schema, '{"type":"object"}');
    const grandchild = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`;
    const middle = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { detached: true, stdio: "ignore" }); setInterval(() => {}, 1000);`;
    const event = engine === "codex" ? { type: "turn.completed", usage: { input_tokens: 35, output_tokens: 7 } } :
      { type: "stream_event", session_id: id, event: { type: "message_start", message: { id: "budget", usage: { input_tokens: 35, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } };
    const script = `#!${process.execPath}\nrequire("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(middle)}], { stdio: "ignore" });\nconst poll = setInterval(() => { if (require("node:fs").existsSync(${JSON.stringify(pidFile)})) { clearInterval(poll); process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")}); } }, 10); setInterval(() => {}, 1000);`;
    await writeFile(join(dir, engine), script); await chmod(join(dir, engine), 0o755);
    const envFor = (env: NodeJS.ProcessEnv) => ({ ...env, PATH: `${dir}:${env.PATH}` });
    const runtime = engine === "codex" ? new CodexRuntime(dir, 5000, undefined, undefined, undefined, false, envFor) : new ClaudeRuntime(dir, 5000, undefined, undefined, false, envFor);
    const result = await runtime.message("Fixture only", schema, undefined, { signal: controller.signal, onUsage: () => controller.abort() }).catch((error: unknown) => error);
    expect(result).toBeInstanceOf(AgentRunError);
    expect((result as AgentRunError).facts.status).toBe("interrupted");
    pid = Number(await readFile(pidFile, "utf8"));
    expect((await listProcesses()).some((row) => row.pid === pid)).toBe(false);
  } finally {
    controller.abort();
    if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already ended */ }
    await rm(dir, { recursive: true, force: true });
  }
}, 10_000);
