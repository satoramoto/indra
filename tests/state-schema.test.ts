import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile, execFileSync, spawnSync, type ExecFileOptions } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureOpEnvironment, childEnv, opEnv, opVariablesIn, releaseOpEnvironment, stateRepoToken } from "../src/op-env.js";
import { STATE_CREDENTIAL_CONFIG, StateGit } from "../src/state-commit.js";
import { STATE_SCHEMA_PATH, syncStateSchema } from "../src/state-schema.js";
import { git, stateCheckout } from "./state-checkout.js";

vi.mock("node:child_process", { spy: true });

const state = {
  $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], planningGoals: [],
  teams: [{ id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "team" } }, seats: [{ id: "seat-001", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { userId: "chick", username: "chickcorea" } } }] }],
};
const subjects = (dir: string) => git(dir, "log", "--format=%s").trim().split("\n").reverse();
const exists = (file: string) => stat(file).then(() => true, () => false);
const TOKEN = "github_pat_statetoken_0123456789abcdef";

/** A state checkout cloned from a bare remote, so the sync has an upstream to push to. */
async function clonedCheckout(): Promise<{ checkout: string; remote: string }> {
  const seed = await stateCheckout("indra-schema-seed-", state);
  const remote = await mkdtemp(join(tmpdir(), "indra-schema-remote-"));
  git(remote, "init", "--quiet", "--bare", "--initial-branch=main");
  git(seed, "push", "--quiet", remote, "main");
  const checkout = join(await mkdtemp(join(tmpdir(), "indra-schema-clone-")), "indra-state");
  execFileSync("git", ["clone", "--quiet", remote, checkout]);
  return { checkout, remote };
}

/** An Indra checkout with a linear history older → running → newer. */
async function appHistory(): Promise<{ appDir: string; older: string; running: string; newer: string }> {
  const appDir = await mkdtemp(join(tmpdir(), "indra-schema-app-"));
  git(appDir, "init", "--quiet", "--initial-branch=main");
  const commit = (message: string) => { git(appDir, "commit", "--quiet", "--allow-empty", "-m", message); return git(appDir, "rev-parse", "HEAD").trim(); };
  return { appDir, older: commit("older"), running: commit("running"), newer: commit("newer") };
}

afterEach(() => { vi.mocked(execFile).mockReset(); releaseOpEnvironment(); delete process.env.INDRA_STATE_GITHUB_TOKEN; });

describe("state schema sync", () => {
  it("installs this build's schema verbatim, commits only that file, pushes it, and does nothing when it matches", async () => {
    const { checkout, remote } = await clonedCheckout();
    const { appDir, running, newer } = await appHistory();
    await writeFile(join(checkout, "scratch.txt"), "untracked\n");
    const result = await syncStateSchema(checkout, { sha: running, appDir });
    expect(result.outcome).toBe("committed");
    expect(result.sync?.outcome).toBe("synced");
    expect(await readFile(join(checkout, STATE_SCHEMA_PATH), "utf8")).toBe(await readFile(resolve(STATE_SCHEMA_PATH), "utf8"));
    expect(subjects(checkout)).toEqual(["Initial state", `Update state schema from Indra ${running}`]);
    expect(git(checkout, "show", "--name-only", "--format=", "HEAD").trim()).toBe(STATE_SCHEMA_PATH);
    expect(git(remote, "log", "-1", "--format=%s", "main").trim()).toBe(`Update state schema from Indra ${running}`);
    expect(git(checkout, "status", "--porcelain")).toBe("?? scratch.txt\n");

    expect((await syncStateSchema(checkout, { sha: running, appDir })).outcome).toBe("unchanged");
    expect(subjects(checkout)).toHaveLength(2);

    // A later build that includes the one that wrote the schema replaces it.
    const next = '{ "title": "next" }\n';
    expect((await syncStateSchema(checkout, { schema: next, sha: newer, appDir })).outcome).toBe("committed");
    expect(subjects(checkout).at(-1)).toBe(`Update state schema from Indra ${newer}`);
    expect(git(checkout, "show", "--name-only", "--format=", "HEAD").trim()).toBe(STATE_SCHEMA_PATH);
    expect(git(checkout, "show", `HEAD:${STATE_SCHEMA_PATH}`)).toBe(next);
    const ancestry = vi.mocked(execFile).mock.calls.find((call) => (call[1] as string[]).includes("merge-base"));
    expect(ancestry?.slice(0, 2)).toEqual(["git", ["-C", appDir, "merge-base", "--is-ancestor", running, newer]]);
    const options = ancestry![2] as ExecFileOptions;
    expect(options).toMatchObject({ timeout: 10_000, env: { GIT_TERMINAL_PROMPT: "0" } });
    expect(options.cwd).toBeUndefined();
    expect(options.maxBuffer).toBeUndefined();
    expect(options.env?.INDRA_STATE_GITHUB_TOKEN).toBeUndefined();
    expect(Object.keys(options.env!).some((key) => key.startsWith("OP_"))).toBe(false);
  });

  it("never downgrades a schema written by a build this one does not include", async () => {
    const checkout = await stateCheckout("indra-schema-newer-", state);
    const { appDir, older, newer } = await appHistory();
    expect((await syncStateSchema(checkout, { schema: '{ "v": "newer" }\n', sha: newer, appDir })).outcome).toBe("committed");
    const rolledBack = await syncStateSchema(checkout, { schema: '{ "v": "older" }\n', sha: older, appDir });
    expect(rolledBack.outcome).toBe("skipped");
    expect(rolledBack.message).toContain("does not include");
    expect(await readFile(join(checkout, STATE_SCHEMA_PATH), "utf8")).toBe('{ "v": "newer" }\n');
    expect(subjects(checkout)).toHaveLength(2);
  });

  it("leaves the schema alone when it cannot tell whether this build includes the one that wrote it", async () => {
    const checkout = await stateCheckout("indra-schema-unknown-", state);
    const { appDir, running } = await appHistory();
    const stranger = "f".repeat(40);
    expect((await syncStateSchema(checkout, { schema: '{ "v": "stranger" }\n', sha: stranger, appDir: await mkdtemp(join(tmpdir(), "indra-no-app-")) })).outcome).toBe("committed");
    const unknownCommit = await syncStateSchema(checkout, { schema: '{ "v": "mine" }\n', sha: running, appDir });
    expect(unknownCommit.outcome).toBe("skipped");
    expect(unknownCommit.message).toContain("Could not tell");
    expect((await syncStateSchema(checkout, { schema: '{ "v": "mine" }\n', sha: "", appDir })).outcome).toBe("skipped");
    expect(await readFile(join(checkout, STATE_SCHEMA_PATH), "utf8")).toBe('{ "v": "stranger" }\n');
    expect(subjects(checkout)).toEqual(["Initial state", `Update state schema from Indra ${stranger}`]);
  });

  it("refuses, writing nothing, when the checkout has changes someone else made", async () => {
    const checkout = await stateCheckout("indra-schema-dirty-", state);
    const { appDir, running } = await appHistory();
    const stateFile = join(checkout, "state.json");
    const handEdit = JSON.stringify({ ...state, sprints: [] }, null, 4);
    await writeFile(stateFile, handEdit);
    const result = await syncStateSchema(checkout, { schema: "{}\n", sha: running, appDir });
    expect(result.outcome).toBe("dirty");
    expect(await exists(join(checkout, STATE_SCHEMA_PATH))).toBe(false);
    expect(await readFile(stateFile, "utf8")).toBe(handEdit);
    expect(subjects(checkout)).toEqual(["Initial state"]);

    git(checkout, "checkout", "--", "state.json");
    await syncStateSchema(checkout, { schema: "{}\n", sha: running, appDir });
    const schemaFile = join(checkout, STATE_SCHEMA_PATH);
    await writeFile(schemaFile, '{ "hand": true }\n');
    expect((await syncStateSchema(checkout, { schema: '{ "new": true }\n', sha: running, appDir })).outcome).toBe("dirty");
    expect(await readFile(schemaFile, "utf8")).toBe('{ "hand": true }\n');
    expect(subjects(checkout)).toEqual(["Initial state", `Update state schema from Indra ${running}`]);
  });
});

describe("state repository token", () => {
  let server: Server | undefined;
  afterEach(async () => { await new Promise((done) => server ? server.close(done) : done(undefined)); server = undefined; });

  /** What the state credential helper answers for `url`, through git's own credential machinery. */
  function credentialFor(protocol: string, host: string, path: string): string {
    const result = spawnSync("git", [...STATE_CREDENTIAL_CONFIG, "credential", "fill"], {
      input: `protocol=${protocol}\nhost=${host}\npath=${path}\n\n`, encoding: "utf8",
      env: { ...childEnv(), GIT_TERMINAL_PROMPT: "0", INDRA_STATE_GITHUB_TOKEN: TOKEN },
    });
    return `${result.stdout}${result.stderr}`;
  }

  it("answers only for https://github.com/satoramoto/indra-state", () => {
    expect(credentialFor("https", "github.com", "satoramoto/indra-state.git")).toContain(`password=${TOKEN}`);
    expect(credentialFor("https", "github.com", "satoramoto/indra-state")).toContain(`password=${TOKEN}`);
    for (const [protocol, host, path] of [["https", "evil.example", "satoramoto/indra-state.git"], ["http", "github.com", "satoramoto/indra-state.git"], ["https", "github.com", "satoramoto/other.git"], ["https", "github.com.evil.example", "satoramoto/indra-state.git"]]) {
      expect(credentialFor(protocol, host, path)).not.toContain(TOKEN);
    }
  });

  /** A fake remote that asks for credentials and records any, and a git on PATH that logs each call. */
  async function fakeRemote(checkout: string, which: "fetch" | "push"): Promise<{ authorizations: string[]; calls: () => Promise<string[]>; restore: () => void }> {
    const authorizations: string[] = [];
    server = createServer((request, response) => {
      const auth = request.headers.authorization;
      if (!auth) { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end(); return; }
      authorizations.push(auth);
      response.writeHead(500).end("broken");
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/satoramoto/indra-state.git`;
    if (which === "fetch") git(checkout, "remote", "set-url", "origin", url);
    else git(checkout, "remote", "set-url", "--push", "origin", url);
    const bin = await mkdtemp(join(tmpdir(), "indra-git-shim-"));
    const log = join(bin, "calls.log");
    const realGit = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(join(bin, "git"), `#!/bin/sh\nprintf '%s|%s\\n' "$*" "\${INDRA_STATE_GITHUB_TOKEN:+has-token}" >> "${log}"\nexec "${realGit}" "$@"\n`);
    await chmod(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    return {
      authorizations,
      calls: async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n"),
      restore: () => { process.env.PATH = path; },
    };
  }

  const withToken = () => {
    process.env.INDRA_STATE_GITHUB_TOKEN = TOKEN;
    captureOpEnvironment();
    expect(process.env.INDRA_STATE_GITHUB_TOKEN).toBeUndefined();
    expect(stateRepoToken()).toBe(TOKEN);
  };
  const authenticated = (line: string) => line.endsWith("|has-token") && line.includes("credential.helper=!f()") && line.includes("credential.useHttpPath=true");

  it("gives the token only to state fetches, never to another host, args, other git commands or error text", async () => {
    withToken();
    const { checkout } = await clonedCheckout();
    const remote = await fakeRemote(checkout, "fetch");
    try {
      const result = await new StateGit(checkout).sync();
      expect(result.outcome).toBe("offline");
      expect(result.message).not.toContain(TOKEN);
      expect(remote.authorizations).toEqual([]); // 127.0.0.1 is not github.com.
      const calls = await remote.calls();
      const fetches = calls.filter((line) => / fetch /.test(line));
      expect(fetches.length).toBeGreaterThan(0);
      expect(fetches.every(authenticated)).toBe(true);
      const others = calls.filter((line) => !/ fetch /.test(line));
      expect(others.length).toBeGreaterThan(0);
      expect(others.every((line) => line.endsWith("|"))).toBe(true);
      expect(calls.some((line) => line.includes(TOKEN))).toBe(false);
      expect(git(checkout, "config", "--list")).not.toContain(TOKEN);
    } finally { remote.restore(); }
  });

  it("gives the token to the sync's push and to the background push", async () => {
    withToken();
    const { checkout } = await clonedCheckout();
    await mkdir(join(checkout, "notes"));
    await writeFile(join(checkout, "notes", "a.txt"), "a\n");
    git(checkout, "add", "notes/a.txt");
    git(checkout, "commit", "--quiet", "-m", "Local");
    const remote = await fakeRemote(checkout, "push");
    try {
      const git_ = new StateGit(checkout);
      const result = await git_.sync();
      expect(result.outcome).toBe("push-failed");
      expect(result.message).not.toContain(TOKEN);
      const pushes = (await remote.calls()).filter((line) => / push /.test(line));
      expect(pushes).toHaveLength(1);
      expect(pushes.every(authenticated)).toBe(true);

      git_.pushInBackground();
      await vi.waitFor(async () => expect((await remote.calls()).filter((line) => / push /.test(line))).toHaveLength(2), { timeout: 10_000 });
      expect((await remote.calls()).filter((line) => / push /.test(line)).every(authenticated)).toBe(true);
      expect(remote.authorizations).toEqual([]);
    } finally { remote.restore(); }
  });

  it("keeps ambient credentials when no token is supplied", async () => {
    const { checkout } = await clonedCheckout();
    const remote = await fakeRemote(checkout, "fetch");
    try {
      expect((await new StateGit(checkout).sync()).outcome).toBe("offline");
      expect((await remote.calls()).some((line) => line.includes("credential.helper"))).toBe(false);
    } finally { remote.restore(); }
  });

  it("keeps the token from every other child process, op included", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/bin", INDRA_STATE_GITHUB_TOKEN: TOKEN, OP_SERVICE_ACCOUNT_TOKEN: "ops_x" };
    captureOpEnvironment(env);
    expect(env).toEqual({ PATH: "/bin" });
    process.env.INDRA_STATE_GITHUB_TOKEN = "leaked-later";
    expect(childEnv().INDRA_STATE_GITHUB_TOKEN).toBeUndefined();
    expect(opEnv().INDRA_STATE_GITHUB_TOKEN).toBeUndefined();
    expect(opEnv().OP_SERVICE_ACCOUNT_TOKEN).toBe("ops_x");
    expect(opVariablesIn(`HOME=/h\nINDRA_STATE_GITHUB_TOKEN=${TOKEN}\nOP_SESSION_me=s`)).toEqual(["INDRA_STATE_GITHUB_TOKEN", "OP_SESSION_me"]);
  });
});
