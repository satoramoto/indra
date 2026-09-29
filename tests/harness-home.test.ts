import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVELOPER_CODEX_CONFIG as CODEX_CONFIG, PRODUCT_CODEX_CONFIG, TEAM_LEAD_CODEX_CONFIG, codexConfigForRoles, engineHome, ensureCodexHome, ownerCodexAuth, promoteSeatAuth, seatHarnessDir, writeFileAtomic } from "../src/harness-home.js";
import { CodexRuntime } from "../src/codex-runtime.js";
import { claudePermissionArgs } from "../src/claude-runtime.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
class Process extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  finish(lines: object[], code = 0, stderr = "") {
    this.stderr.end(stderr); this.stdout.end(lines.map((line) => JSON.stringify(line)).join("\n"));
    this.stdout.on("end", () => setImmediate(() => this.emit("close", code))); this.stdout.resume();
  }
}
const reply = [{ type: "thread.started", thread_id: "thread-1" }, { type: "item.completed", item: { type: "agent_message", text: "{\"ok\":true}" } }, { type: "turn.completed", usage: { input_tokens: 1 } }];

let root: string; let owner: string; let runtimeDir: string; let child: Process;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "indra-harness-"));
  owner = join(root, "owner"); runtimeDir = join(root, "state.runtime");
  await mkdir(join(owner, ".codex"), { recursive: true });
  await writeFile(join(owner, ".codex", "auth.json"), "{\"test\":\"not-a-real-login\"}");
  await writeFile(join(owner, ".codex", "AGENTS.md"), "Personal instructions");
  await writeFile(join(owner, ".codex", "config.toml"), "model = \"personal\"\n[mcp_servers.personal]\ncommand = \"x\"\n");
  vi.stubEnv("HOME", owner); vi.stubEnv("CODEX_HOME", undefined);
  child = new Process(); vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); await rm(root, { recursive: true, force: true }); });

const mode = async (path: string) => (await stat(path)).mode & 0o777;
async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? await files(join(dir, entry.name)) : [join(dir, entry.name)]))).flat();
}

describe("seat harness homes", () => {
  it("places each seat's engine home under the runtime directory and refuses unsafe seat IDs", () => {
    expect(engineHome(seatHarnessDir(runtimeDir, "seat-001"), "codex")).toBe(join(runtimeDir, "harness", "seat-001", "codex"));
    for (const bad of ["../seat", "Seat", "seat/x", ""]) expect(() => seatHarnessDir(runtimeDir, bad)).toThrow("Invalid seat ID");
  });

  it("creates a 0700 Codex home idempotently with only a minimal config and a link to the owner's login", async () => {
    const home = engineHome(seatHarnessDir(runtimeDir, "seat-001"), "codex");
    expect(ownerCodexAuth()).toBe(join(owner, ".codex", "auth.json"));
    for (let run = 0; run < 2; run++) {
      await ensureCodexHome(home, CODEX_CONFIG);
      for (const dir of [join(runtimeDir, "harness"), join(runtimeDir, "harness", "seat-001"), home]) expect(await mode(dir)).toBe(0o700);
      expect((await readdir(home)).sort()).toEqual(["auth.json", "config.toml"]);
      expect(await readFile(join(home, "config.toml"), "utf8")).toBe(CODEX_CONFIG);
      expect((await lstat(join(home, "auth.json"))).isSymbolicLink()).toBe(true);
      expect(await readlink(join(home, "auth.json"))).toBe(join(owner, ".codex", "auth.json"));
    }
    // Exactly the owner's seat model and effort; no MCP, hooks, skills or profiles.
    expect(CODEX_CONFIG).toBe("model = \"gpt-6-sol\"\nmodel_reasoning_effort = \"medium\"\n");
  });

  it("picks the Codex model by the seat's role, falling back to Developer", () => {
    expect(codexConfigForRoles(["Developer"])).toBe("model = \"gpt-6-sol\"\nmodel_reasoning_effort = \"medium\"\n");
    expect(codexConfigForRoles(["Team Lead"])).toBe("model = \"gpt-6-astra\"\nmodel_reasoning_effort = \"max\"\n");
    expect(codexConfigForRoles(["Product"])).toBe("model = \"gpt-6-astra\"\nmodel_reasoning_effort = \"medium\"\n");
    expect(TEAM_LEAD_CODEX_CONFIG).not.toBe(PRODUCT_CODEX_CONFIG);
    for (const roles of [undefined, [], ["Unknown"]]) expect(codexConfigForRoles(roles)).toBe(CODEX_CONFIG);
  });

  it("rewrites an existing home's config when the seat's role config changes", async () => {
    const home = engineHome(seatHarnessDir(runtimeDir, "seat-002"), "codex");
    await ensureCodexHome(home, TEAM_LEAD_CODEX_CONFIG);
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(TEAM_LEAD_CODEX_CONFIG);
    await ensureCodexHome(home, codexConfigForRoles(["Developer"]));
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(CODEX_CONFIG);
  });

  it("replaces a copied auth file or a stale link with the link to the owner's login", async () => {
    const home = join(runtimeDir, "harness", "seat-001", "codex");
    await mkdir(home, { recursive: true, mode: 0o755 });
    await writeFile(join(home, "auth.json"), "copied credentials");
    await writeFile(join(home, "config.toml"), "# earlier run\nmodel = \"personal\"\n[mcp_servers.personal]\ncommand = \"x\"\n");
    await ensureCodexHome(home, CODEX_CONFIG);
    expect(await mode(home)).toBe(0o700);
    expect(await readlink(join(home, "auth.json"))).toBe(join(owner, ".codex", "auth.json"));
    expect(await readFile(join(home, "config.toml"), "utf8")).toBe(CODEX_CONFIG);
    await ensureCodexHome(home, CODEX_CONFIG, join(root, "other-auth.json"));
    expect(await readlink(join(home, "auth.json"))).toBe(join(root, "other-auth.json"));
  });

  it("spawns Codex with CODEX_HOME set to the seat home and references nothing else under the owner's home", async () => {
    vi.stubEnv("OP_SERVICE_ACCOUNT_TOKEN", "test-only-op-token");
    const home = engineHome(seatHarnessDir(runtimeDir, "seat-001"), "codex");
    const run = new CodexRuntime(join(root, "worktree"), 60_000, { extraDirs: [join(root, "shared.git")] }, home).message("Build", join(root, "schema.json"));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    const [command, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(command).toBe("codex");
    const env = options?.env ?? {};
    expect(env.CODEX_HOME).toBe(home); expect(env).not.toHaveProperty("OP_SERVICE_ACCOUNT_TOKEN");
    const values = [...(args as string[]), ...Object.entries(env).filter(([key]) => key !== "HOME").map(([, value]) => String(value))];
    for (const value of values) expect(value.includes(owner), value).toBe(false);
    for (const file of await files(home)) {
      if ((await lstat(file)).isSymbolicLink()) expect(await readlink(file)).toBe(join(owner, ".codex", "auth.json"));
      else expect(await readFile(file, "utf8")).not.toContain(owner);
    }
    child.finish(reply);
    expect(await run).toMatchObject({ sessionId: "thread-1", response: { ok: true } });
  });

  it("resumes inside the seat home and says clearly when a session is not there", async () => {
    const home = engineHome(seatHarnessDir(runtimeDir, "seat-001"), "codex");
    const run = new CodexRuntime(join(root, "worktree"), 60_000, undefined, home).message("Next", join(root, "schema.json"), "old-thread");
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(expect.arrayContaining(["resume", "old-thread"]));
    expect(vi.mocked(spawn).mock.calls[0][2]?.env?.CODEX_HOME).toBe(home);
    child.finish([], 1, "Error: thread/resume: thread/resume failed: no rollout found for thread id old-thread (code -32600)");
    await expect(run).rejects.toThrow("Codex session old-thread is not in this seat's harness home");
  });

  it("keeps the inherited environment when no home is given", async () => {
    vi.stubEnv("CODEX_HOME", join(owner, ".codex"));
    const run = new CodexRuntime(join(root, "worktree")).message("Task", join(root, "schema.json"));
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(spawn).mock.calls[0][2]?.env?.CODEX_HOME).toBe(join(owner, ".codex"));
    child.finish(reply); await run;
    await expect(stat(join(runtimeDir, "harness"))).rejects.toThrow();
  });

  it("gives Claude no settings sources, MCP servers, hooks, slash commands or auto-memory", async () => {
    const args = await claudePermissionArgs(root, { extraDirs: [] });
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(JSON.parse(args[args.indexOf("--settings") + 1])).toMatchObject({ disableAllHooks: true, autoMemoryEnabled: false });
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--disable-slash-commands"]));
    expect(JSON.parse(args[args.indexOf("--mcp-config") + 1])).toEqual({ mcpServers: {} });
  });
});

describe("seat auth promotion and config writes", () => {
  const ownerAuth = () => join(owner, ".codex", "auth.json");
  const seatHome = () => engineHome(seatHarnessDir(runtimeDir, "dev-1"), "codex");

  it("promotes a newer regular seat auth.json over the owner's and restores the symlink", async () => {
    const home = await ensureCodexHome(seatHome(), CODEX_CONFIG, ownerAuth());
    await writeFile(join(owner, ".codex", "auth.json"), JSON.stringify({ last_refresh: "2026-01-01T00:00:00Z" }));
    await utimes(ownerAuth(), new Date("2026-01-01"), new Date("2026-01-01"));
    await unlink(join(home, "auth.json"));
    await writeFile(join(home, "auth.json"), JSON.stringify({ last_refresh: "2026-09-01T00:00:00Z", fake: "rotated", tokens: { refresh_token: "fake-refresh" } }));
    expect(await promoteSeatAuth(home, ownerAuth())).toBe("promoted");
    expect(JSON.parse(await readFile(ownerAuth(), "utf8"))).toMatchObject({ fake: "rotated" });
    expect(await mode(ownerAuth())).toBe(0o600);
    await ensureCodexHome(home, CODEX_CONFIG, ownerAuth());
    expect((await lstat(join(home, "auth.json"))).isSymbolicLink()).toBe(true);
    expect(await readlink(join(home, "auth.json"))).toBe(ownerAuth());
  });

  it("discards an older regular seat auth.json and keeps the owner's", async () => {
    const home = await ensureCodexHome(seatHome(), CODEX_CONFIG, ownerAuth());
    await writeFile(ownerAuth(), JSON.stringify({ last_refresh: "2026-09-01T00:00:00Z", fake: "owner" }));
    await unlink(join(home, "auth.json"));
    await writeFile(join(home, "auth.json"), JSON.stringify({ last_refresh: "2026-01-01T00:00:00Z", fake: "stale", tokens: { refresh_token: "fake-old" } }));
    await utimes(join(home, "auth.json"), new Date("2026-01-01"), new Date("2026-01-01"));
    await ensureCodexHome(home, CODEX_CONFIG, ownerAuth());
    expect(JSON.parse(await readFile(ownerAuth(), "utf8"))).toMatchObject({ fake: "owner" });
    expect(await readlink(join(home, "auth.json"))).toBe(ownerAuth());
  });

  it.each([
    ["an empty seat file", ""],
    ["a corrupt seat file", "{\"tokens\": {"],
    ["valid JSON without tokens", JSON.stringify({ last_refresh: "2030-01-01T00:00:00Z" })],
  ])("discards %s and leaves the owner's file untouched", async (_name, content) => {
    const home = await ensureCodexHome(seatHome(), CODEX_CONFIG, ownerAuth());
    const ownerBefore = await readFile(ownerAuth(), "utf8");
    await unlink(join(home, "auth.json"));
    await writeFile(join(home, "auth.json"), content);
    expect(await promoteSeatAuth(home, ownerAuth())).toBe("discarded");
    expect(await readFile(ownerAuth(), "utf8")).toBe(ownerBefore);
  });

  it("discards an invalid seat file when the owner's file is unreadable, leaving the owner's untouched", async () => {
    const home = await ensureCodexHome(seatHome(), CODEX_CONFIG, ownerAuth());
    await unlink(join(home, "auth.json"));
    await writeFile(join(home, "auth.json"), "not json");
    await chmod(ownerAuth(), 0o000);
    try { expect(await promoteSeatAuth(home, ownerAuth())).toBe("discarded"); }
    finally { await chmod(ownerAuth(), 0o600); }
    expect(await readFile(ownerAuth(), "utf8")).toBe("{\"test\":\"not-a-real-login\"}");
  });

  it("leaves the symlink alone", async () => {
    const home = await ensureCodexHome(seatHome(), CODEX_CONFIG, ownerAuth());
    expect(await promoteSeatAuth(home, ownerAuth())).toBe("none");
  });

  it("writes config.toml by temp file and rename, and skips identical content", async () => {
    const home = await ensureCodexHome(seatHome(), CODEX_CONFIG, ownerAuth());
    const config = join(home, "config.toml");
    await writeFile(config, "stale");
    const before = (await stat(config)).ino;
    await ensureCodexHome(home, CODEX_CONFIG, ownerAuth());
    expect(await readFile(config, "utf8")).toBe(CODEX_CONFIG);
    const replaced = (await stat(config)).ino;
    expect(replaced).not.toBe(before);
    expect((await readdir(home)).some((name) => name.endsWith(".tmp"))).toBe(false);
    await ensureCodexHome(home, CODEX_CONFIG, ownerAuth());
    expect((await stat(config)).ino).toBe(replaced);
    await writeFileAtomic(config, "x");
    expect(await readFile(config, "utf8")).toBe("x");
  });
});
