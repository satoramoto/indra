import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureOpEnvironment, childEnv, opEnv, opVariablesIn, releaseOpEnvironment, stateRepoToken } from "../src/op-env.js";
import { StateGit } from "../src/state-commit.js";
import { STATE_SCHEMA_PATH, syncStateSchema } from "../src/state-schema.js";
import { git, stateCheckout } from "./state-checkout.js";

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

afterEach(() => { releaseOpEnvironment(); delete process.env.INDRA_STATE_GITHUB_TOKEN; });

describe("state schema sync", () => {
  it("installs this build's schema verbatim, commits only that file, pushes it, and does nothing when it matches", async () => {
    const { checkout, remote } = await clonedCheckout();
    await writeFile(join(checkout, "scratch.txt"), "untracked\n");
    const result = await syncStateSchema(checkout, { sha: "abcdef0123456789" });
    expect(result.outcome).toBe("committed");
    expect(result.sync?.outcome).toBe("synced");
    expect(await readFile(join(checkout, STATE_SCHEMA_PATH), "utf8")).toBe(await readFile(resolve(STATE_SCHEMA_PATH), "utf8"));
    expect(subjects(checkout)).toEqual(["Initial state", "Update state schema from Indra abcdef0"]);
    expect(git(checkout, "show", "--name-only", "--format=", "HEAD").trim()).toBe(STATE_SCHEMA_PATH);
    expect(git(remote, "log", "-1", "--format=%s", "main").trim()).toBe("Update state schema from Indra abcdef0");
    expect(git(checkout, "status", "--porcelain")).toBe("?? scratch.txt\n");

    expect((await syncStateSchema(checkout, { sha: "abcdef0123456789" })).outcome).toBe("unchanged");
    expect(subjects(checkout)).toHaveLength(2);

    const next = '{ "title": "next" }\n';
    expect((await syncStateSchema(checkout, { schema: next, sha: "" })).outcome).toBe("committed");
    expect(subjects(checkout).at(-1)).toBe("Update state schema from Indra");
    expect(git(checkout, "show", "--name-only", "--format=", "HEAD").trim()).toBe(STATE_SCHEMA_PATH);
    expect(git(checkout, "show", `HEAD:${STATE_SCHEMA_PATH}`)).toBe(next);
  });

  it("refuses, writing nothing, when the checkout has changes someone else made", async () => {
    const checkout = await stateCheckout("indra-schema-dirty-", state);
    const stateFile = join(checkout, "state.json");
    const handEdit = JSON.stringify({ ...state, sprints: [] }, null, 4);
    await writeFile(stateFile, handEdit);
    const result = await syncStateSchema(checkout, { schema: "{}\n", sha: "abc" });
    expect(result.outcome).toBe("dirty");
    expect(await exists(join(checkout, STATE_SCHEMA_PATH))).toBe(false);
    expect(await readFile(stateFile, "utf8")).toBe(handEdit);
    expect(subjects(checkout)).toEqual(["Initial state"]);

    git(checkout, "checkout", "--", "state.json");
    await syncStateSchema(checkout, { schema: "{}\n", sha: "abc" });
    const schemaFile = join(checkout, STATE_SCHEMA_PATH);
    await writeFile(schemaFile, '{ "hand": true }\n');
    expect((await syncStateSchema(checkout, { schema: '{ "new": true }\n', sha: "abc" })).outcome).toBe("dirty");
    expect(await readFile(schemaFile, "utf8")).toBe('{ "hand": true }\n');
    expect(subjects(checkout)).toEqual(["Initial state", "Update state schema from Indra abc"]);
  });
});

describe("state repository token", () => {
  let server: Server | undefined;
  afterEach(async () => { await new Promise((done) => server ? server.close(done) : done(undefined)); server = undefined; });

  /** A fake GitHub that asks for credentials, records them, then fails; and a git on PATH that logs each call. */
  async function fakeRemote(checkout: string): Promise<{ authorizations: string[]; calls: () => Promise<string[]>; restore: () => void }> {
    const authorizations: string[] = [];
    server = createServer((request, response) => {
      const auth = request.headers.authorization;
      if (!auth) { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="GitHub"' }).end(); return; }
      authorizations.push(Buffer.from(auth.replace(/^Basic /, ""), "base64").toString("utf8"));
      response.writeHead(500).end("broken");
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
    const port = (server.address() as { port: number }).port;
    git(checkout, "remote", "set-url", "origin", `http://127.0.0.1:${port}/satoramoto/indra-state.git`);
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

  it("authenticates state fetches with the owner's token, which never reaches args, other git commands or error text", async () => {
    process.env.INDRA_STATE_GITHUB_TOKEN = TOKEN;
    captureOpEnvironment();
    expect(process.env.INDRA_STATE_GITHUB_TOKEN).toBeUndefined();
    expect(stateRepoToken()).toBe(TOKEN);
    const { checkout } = await clonedCheckout();
    const remote = await fakeRemote(checkout);
    try {
      const result = await new StateGit(checkout).sync();
      expect(result.outcome).toBe("offline");
      expect(result.message).not.toContain(TOKEN);
      expect(remote.authorizations).toContain(`x-access-token:${TOKEN}`);
      const calls = await remote.calls();
      const fetches = calls.filter((line) => / fetch /.test(line));
      expect(fetches.length).toBeGreaterThan(0);
      expect(fetches.every((line) => line.endsWith("|has-token") && line.includes("credential.helper="))).toBe(true);
      const others = calls.filter((line) => !/ fetch /.test(line));
      expect(others.length).toBeGreaterThan(0);
      expect(others.every((line) => line.endsWith("|"))).toBe(true);
      expect(calls.some((line) => line.includes(TOKEN))).toBe(false);
      expect(git(checkout, "config", "--list")).not.toContain(TOKEN);
    } finally { remote.restore(); }
  });

  it("keeps ambient credentials when no token is supplied", async () => {
    const { checkout } = await clonedCheckout();
    const remote = await fakeRemote(checkout);
    try {
      expect((await new StateGit(checkout).sync()).outcome).toBe("offline");
      expect(remote.authorizations).toEqual([]);
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
