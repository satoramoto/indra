import { randomUUID } from "node:crypto";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Shell } from "../src/command-shell.js";
import { PlanningStore } from "../src/planning.js";
import { botTokenRef } from "../src/planning-mattermost.js";
import { branchHasNoPr, createOwnerControls, credentialIdentity } from "../src/seat-provisioning.js";
import type { SeatRecord, TeamRecord } from "../src/state-domain.js";
import { stateCheckout } from "./state-checkout.js";

const pending: SeatRecord = { id: "seat-new", displayName: "Product", roles: ["Product"], status: "pending", externalIdentities: { mattermost: { username: "yahaha-product" } } };
const me = { id: "bot-user-id", username: "yahaha-product", is_bot: true, delete_at: 0 };
const credential = async () => ({});
const unused = async () => randomUUID();

describe("source branch PR reconciliation", () => {
  const team: TeamRecord = { id: "team-001", slug: "yahaha", displayName: "Yahaha", project: { github: "o/r" },
    externalIdentities: { mattermost: { teamId: "mm-team" } }, seats: [pending] };
  const branch = "seat-002/goal-test-outcome-1-attempt-00000000-0000-4000-8000-000000000001";

  it("confirms absence with an owner GET for the exact repository and head across all PR states and bases", async () => {
    const run = vi.fn<Shell["run"]>(async () => ({ code: 0, stdout: "[]", stderr: "" }));
    expect(await branchHasNoPr("/state", team, branch, { run })).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith("gh", ["api", "repos/o/r/pulls", "--method", "GET",
      "-f", "state=all", "-f", `head=o:${branch}`, "-f", "per_page=1"], "/state");
  });

  it.each(["open", "closed", "merged"])("keeps work with a remote %s PR, including a PR still targeting main", async (state) => {
    const run = vi.fn<Shell["run"]>(async () => ({ code: 0, stderr: "", stdout: JSON.stringify([
      { html_url: "https://github.com/o/r/pull/1", state: state === "open" ? "open" : "closed", merged_at: state === "merged" ? "2026-01-01T00:00:00Z" : null,
        head: { ref: branch }, base: { ref: "main" } },
    ]) }));
    expect(await branchHasNoPr("/state", team, branch, { run })).toBe(false);
  });

  it.each([
    ["failed command", 1, "[]"], ["empty response", 0, ""], ["malformed JSON", 0, "private diagnostics"],
    ["unexpected object", 0, "{}"], ["null", 0, "null"],
  ])("refuses transfer on %s", async (_name, code, stdout) => {
    expect(await branchHasNoPr("/state", team, branch, { run: async () => ({ code: Number(code), stdout: String(stdout), stderr: "private diagnostics" }) })).toBe(false);
  });

  it("refuses missing or invalid projects and transport errors without exposing diagnostics", async () => {
    const run = vi.fn<Shell["run"]>(async () => { throw new Error("private diagnostics"); });
    expect(await branchHasNoPr("/state", { ...team, project: undefined }, branch, { run })).toBe(false);
    expect(await branchHasNoPr("/state", { ...team, project: { github: "../r" } }, branch, { run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(await branchHasNoPr("/state", team, branch, { run })).toBe(false);
  });
});

describe("credential identity verification", () => {
  it("reads the exact bot's item and only GETs the authenticated user, refusing redirects", async () => {
    const token = randomUUID();
    const read = vi.fn(async () => token);
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(me)));
    expect(await credentialIdentity("/state", pending, read, request, credential)).toEqual({ userId: me.id, username: me.username, isBot: true });
    expect(botTokenRef(pending.externalIdentities.mattermost.username)).toBe("op://Agent Rig/Mattermost bot - yahaha-product/token");
    expect(read).toHaveBeenCalledWith("yahaha-product", { headless: true });
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe("https://mattermost.newegypt.io/api/v4/users/me");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
    expect(init?.body).toBeUndefined();
    expect((init?.headers as Record<string, string>).Authorization === `Bearer ${token}`).toBe(true);
  });

  it.each(["missing", "empty", "rejected"])("leaves %s credentials pending without returning their value or error", async (kind) => {
    const token = randomUUID();
    const read = async () => { if (kind === "empty") return "  "; throw new Error(`untrusted output ${token}`); };
    const request = vi.fn<typeof fetch>();
    expect(await credentialIdentity("/state", pending, read, request, credential)).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([401, 403, 302, 500])("keeps HTTP %i pending without following or exposing the response", async (status) => {
    const request = vi.fn<typeof fetch>(async () => new Response(randomUUID(), { status, headers: { location: "https://elsewhere.example/" } }));
    expect(await credentialIdentity("/state", pending, unused, request, credential)).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][1]?.redirect).toBe("manual");
  });

  it.each([
    { ...me, username: "another-bot" }, { ...me, is_bot: false }, { id: me.id, username: me.username },
    { ...me, delete_at: 1 }, { ...me, id: "" }, { ...me, id: 3 }, null, [],
  ])("refuses an identity that is not the requested active bot: %j", async (identity) => {
    expect(await credentialIdentity("/state", pending, unused, async () => new Response(JSON.stringify(identity)), credential)).toBeUndefined();
  });

  it("pins a previously known user ID and does not expose malformed responses or transport errors", async () => {
    const known = { ...pending, externalIdentities: { mattermost: { username: me.username, userId: "expected-id" } } };
    expect(await credentialIdentity("/state", known, unused, async () => new Response(JSON.stringify(me)), credential)).toBeUndefined();
    expect(await credentialIdentity("/state", pending, unused, async () => new Response("bad json"), credential)).toBeUndefined();
    expect(await credentialIdentity("/state", pending, unused, async () => { throw new Error(randomUUID()); }, credential)).toBeUndefined();
  });
});

it("wires owner controls to durable pending Product provisioning without account creation or premature process start", async () => {
  const dir = await stateCheckout("indra-provisioning-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], teams: [{
    id: "team-001", slug: "yahaha", displayName: "Yahaha", externalIdentities: { mattermost: { teamId: "mm-team" } }, seats: [{
      id: "seat-001", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { username: "chickcorea", userId: "chick" } },
    }],
  }] });
  await mkdir(join(dir, "schema/v1"), { recursive: true });
  await copyFile("schema/v1/state.schema.json", join(dir, "schema/v1/state.schema.json"));
  const store = new PlanningStore(dir);
  const processes = { ensureAll: vi.fn(async () => []), start: vi.fn(async () => {}), read: vi.fn(async () => ({})), stop: vi.fn(async () => {}), restart: vi.fn(async () => {}) };
  const controls = createOwnerControls({ store, processes, appDir: dir });
  // No service account is staged in this temporary checkout: the adapter cannot invoke op or reach Mattermost.
  await controls.lifecycle!.reconcile();
  await createOwnerControls({ store, processes, appDir: dir }).lifecycle!.reconcile();
  const seats = ((await store.read()).teams as TeamRecord[])[0].seats;
  expect(seats).toHaveLength(2);
  expect(seats[1]).toMatchObject({ status: "pending", roles: ["Product"], externalIdentities: { mattermost: { username: "yahaha-product" } } });
  expect(processes.start).not.toHaveBeenCalled();
  expect(processes.ensureAll).not.toHaveBeenCalled();
  await controls.lifecycle!.remove({ teamId: "team-001", seatId: seats[1].id, expected: seats[1] });
  await controls.lifecycle!.reconcile();
  expect(processes.stop).toHaveBeenCalledWith(seats[1].id);
});
