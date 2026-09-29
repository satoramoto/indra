import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BacklogStore } from "../src/backlog.js";
import { BacklogGroomer } from "../src/backlog-groomer.js";
import type { AgentRuntime } from "../src/codex-runtime.js";
import { loadDeveloperSeat, type RuntimeFactory } from "../src/developer-seat.js";
import { PlanningStore } from "../src/planning.js";
import { createLeadGrooming, groomingRuntimeFor, loadProductSeat, ProductSeat } from "../src/product-seat.js";
import { SeatRuntime } from "../src/seat-runtime.js";
import { isActiveSeat, type SeatRole, type SeatStatus, type TeamRecord } from "../src/state-domain.js";
import { stateCheckout } from "./state-checkout.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).flatMap((dir) => [dir, `${dir}.runtime`]).map((dir) => rm(dir, { recursive: true, force: true }))); });
const teamId = "team-one"; const product = "seat-product";
async function fixture(role: SeatRole = "Product", status: SeatStatus = "active", mission: string | null = "Let the owner steer by value.") {
  const team: TeamRecord = { id: teamId, slug: "team-one", displayName: "Team", ...(mission ? { mission } : {}), project: { github: "acme/demo" }, externalIdentities: { mattermost: { teamId: "mm-team", homeChannelId: "home" } }, seats: [
    { id: "seat-lead", displayName: "Chick", roles: ["Team Lead"], externalIdentities: { mattermost: { username: "chick", userId: "chick" } } },
    { id: product, displayName: "Product", roles: [role], status, externalIdentities: { mattermost: { username: "product", ...(status !== "pending" ? { userId: "product" } : {}) } } },
  ] };
  const dir = await stateCheckout("indra-product-", { $schema: "./schema/v1/state.schema.json", schemaVersion: 1, teams: [team], sprints: [], planningGoals: [] }); dirs.push(dir);
  await mkdir(join(dir, "schema/v1"), { recursive: true });
  await writeFile(join(dir, "schema/v1/state.schema.json"), await readFile(new URL("../schema/v1/state.schema.json", import.meta.url), "utf8"));
  return { store: new PlanningStore(dir), team };
}
const source = { url: "https://github.com/acme/demo/issues/1", text: "The owner repeats sprint planning after releases." };
function runner(store: PlanningStore, team: TeamRecord, message: AgentRuntime["message"]) {
  const runtime = vi.fn<RuntimeFactory>(() => ({ message }));
  const chat = { post: vi.fn() };
  const research = vi.fn(async () => ({ cwd: join(store.runtimeDir, "projects/acme/demo"), sources: [source] }));
  const services = { store: { read: () => store.read(), update: store.update.bind(store), runtimeDir: store.runtimeDir, readRuntimeFile: store.readRuntimeFile.bind(store), saveRuntime: store.saveRuntime.bind(store) },
    team, seat: team.seats.find((seat) => seat.id === product)!, chat, runtimeFor: runtime, log: vi.fn() };
  return { runtime, chat, research, services, seat: new ProductSeat(services, { research }) };
}

describe("Product role dispatch and isolation", () => {
  it("loads the Product identity from state and refuses Developer dispatch", async () => {
    const f = await fixture();
    expect(await loadProductSeat(f.store, product)).toEqual({ id: product, displayName: "Product", username: "product", roles: ["Product"] });
    await expect(loadDeveloperSeat(f.store, product)).rejects.toThrow();
    await expect(loadProductSeat(f.store, "seat-lead")).rejects.toThrow("active Product");
    await expect(loadProductSeat(f.store, "seat-missing")).rejects.toThrow("active Product");
  });

  it.each(["pending", "retiring", "retired"] as const)("does not start new grooming for a %s Product seat", async (status) => {
    const f = await fixture("Product", status); const message = vi.fn<AgentRuntime["message"]>();
    await expect(loadProductSeat(f.store, product)).rejects.toThrow("active Product");
    const run = runner(f.store, f.team, message);
    expect(await run.seat.tick()).toBe("idle");
    expect(run.research).not.toHaveBeenCalled(); expect(message).not.toHaveBeenCalled();
  });

  it("cannot dispatch a Developer as Product or invent a missing owner mission", async () => {
    const f = await fixture("Developer"); const message = vi.fn<AgentRuntime["message"]>();
    await expect(loadProductSeat(f.store, product)).rejects.toThrow("active Product");
    expect(await runner(f.store, f.team, message).seat.tick()).toBe("idle");
    const missing = await fixture("Product", "active", null);
    expect(await runner(missing.store, missing.team, message).seat.tick()).toBe("idle");
    expect(message).not.toHaveBeenCalled();
    expect((await new BacklogStore(missing.store).read(teamId)).mission).toBeUndefined();
  });

  it("passes the live mission to a read-only runtime in the team project and never posts or creates assignments", async () => {
    const f = await fixture(); const before = await f.store.read();
    const message = vi.fn<AgentRuntime["message"]>(async (prompt) => {
      const snapshot = JSON.parse(/^Current team and backlog snapshot: (.+)$/m.exec(prompt)![1]);
      return { sessionId: "product-session", startedAt: "2026-09-29T00:00:00Z", finishedAt: "2026-09-29T00:01:00Z", response: { summary: "No justified change yet.", evidence: [], edit: { expectedRevision: snapshot.revision, ticketChanges: [], candidateChanges: [] } } };
    });
    const run = runner(f.store, f.team, message);
    expect(await run.seat.tick()).toBe("worked");
    expect(run.runtime).toHaveBeenCalledWith(join(f.store.runtimeDir, "projects/acme/demo"));
    expect(run.runtime.mock.calls[0][1]).toBeUndefined();
    expect(message.mock.calls[0][0]).toContain('Current owner mission: "Let the owner steer by value."');
    expect(message.mock.calls[0][0]).toContain("serving as Product");
    expect(message.mock.calls[0][0]).toContain("Do not edit files");
    expect(message.mock.calls[0][1]).toMatch(/schemas\/product\.json$/);
    expect(run.chat.post).not.toHaveBeenCalled();
    expect(await f.store.read()).toEqual(before);
  });

  it("retains per-seat engine selection, harness isolation and read-only access for Lead grooming", async () => {
    const f = await fixture();
    await f.store.saveRuntime("seat-engines", { "seat-lead": "claude" });
    const message = vi.spyOn(SeatRuntime.prototype, "message").mockResolvedValue({ sessionId: "session", response: {}, startedAt: "start", finishedAt: "end" });
    const factory = await groomingRuntimeFor(f.store, "seat-lead");
    await factory(join(f.store.runtimeDir, "projects/acme/demo")).message("Groom", "schema");
    expect(message.mock.instances[0]).toMatchObject({ engine: "claude", cwd: join(f.store.runtimeDir, "projects/acme/demo"), write: undefined, harness: join(f.store.runtimeDir, "harness/seat-lead") });
    await expect(groomingRuntimeFor(f.store, "seat-missing")).rejects.toThrow("Unknown grooming seat");
  });

  it("returns from the bridge hook while runtime preparation is pending and dispatches only the active Lead", async () => {
    const f = await fixture(); let resolve!: (runtime: (cwd: string) => AgentRuntime) => void;
    const preparing = new Promise<(cwd: string) => AgentRuntime>((done) => { resolve = done; });
    const factory = vi.fn(() => preparing);
    const poll = vi.spyOn(BacklogGroomer.prototype, "poll").mockImplementation(() => {});
    const grooming = createLeadGrooming(f.store, factory);
    await grooming({ teamId });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledWith("seat-lead"));
    await grooming({ teamId }); await grooming({ teamId });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(poll).not.toHaveBeenCalled();
    resolve(() => ({ message: vi.fn() }));
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    expect(f.team.seats.find((seat) => seat.roles[0] === "Team Lead" && isActiveSeat(seat))?.id).toBe("seat-lead");
  });
});
