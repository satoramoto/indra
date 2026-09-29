import type { AgentRuntime } from "./codex-runtime.js";
import type { AgentStatePort } from "./autonomy-ports.js";
import { BacklogGroomer, type GroomerOptions } from "./backlog-groomer.js";
import type { SeatIdentity } from "./developer-seat.js";
import { seatHarnessDir } from "./harness-home.js";
import { requireTeamHome, PlanningStore } from "./planning.js";
import type { CeremonyAdapters, PlanningChat } from "./planning-bridge.js";
import { productResearchReader } from "./product-research.js";
import { loadSeatPersonas, withPersonaRuntime } from "./seat-persona.js";
import { loadSeatEngines, SeatRuntime } from "./seat-runtime.js";
import { isActiveSeat, type SeatRecord, type TeamRecord } from "./state-domain.js";

export interface ProductServices {
  store: AgentStatePort & Pick<PlanningStore, "runtimeDir" | "readRuntimeFile" | "saveRuntime">;
  team: TeamRecord; seat: SeatRecord; runtimeFor(cwd: string): AgentRuntime; log(line: string): void;
}

/**
 * BacklogStore reads the Git revision from the state checkout. The CLI supplies only its standard runtime path
 * and restricted writer: derive that checkout, but delegate every write to the original validated transaction.
 * In particular, this adapter must not construct a new writer without the serving store's ceremony readiness.
 */
class ProductStore extends PlanningStore {
  constructor(private readonly port: ProductServices["store"]) {
    if (!port.runtimeDir.endsWith(".runtime")) throw new Error("Product requires the state checkout's runtime directory.");
    super(port.runtimeDir.slice(0, -".runtime".length), port.runtimeDir);
  }
  override read() { return this.port.read(); }
  override update(...args: Parameters<PlanningStore["update"]>) { return this.port.update(...args); }
  override readRuntimeFile<T>(name: string) { return this.port.readRuntimeFile<T>(name); }
  override saveRuntime(name: string, value: object) { return this.port.saveRuntime(name, value); }
  override async updateOwnerSettings(): Promise<void> { throw new Error("Product cannot change owner settings."); }
}

/** Product is dispatched separately from Developers and has no assignment/approval capability. */
export async function loadProductSeat(store: Pick<PlanningStore, "read">, seatId: string): Promise<SeatIdentity> {
  const team = ((await store.read()).teams as TeamRecord[]).find((item) => item.seats.some((seat) => seat.id === seatId));
  const seat = team?.seats.find((item) => item.id === seatId);
  if (!seat || seat.roles.length !== 1 || seat.roles[0] !== "Product" || !isActiveSeat(seat)) throw new Error("Product grooming requires an active Product seat.");
  requireTeamHome(await store.read(), team!.id);
  return { id: seat.id, displayName: seat.displayName, username: seat.externalIdentities.mattermost.username, roles: seat.roles };
}

/** The agent receives only a prompt and a read-only runtime, with no chat, state or approval tools. */
export class ProductSeat {
  private groomer?: BacklogGroomer;
  private readonly store: ProductStore;
  constructor(private readonly services: ProductServices, private readonly options: GroomerOptions = {}) {
    this.store = new ProductStore(services.store);
  }

  async tick(): Promise<"idle" | "worked"> {
    const state = await this.store.read();
    const team = (state.teams as TeamRecord[]).find((item) => item.id === this.services.team.id);
    const current = team?.seats.find((seat) => seat.id === this.services.seat.id);
    if (!current || current.roles[0] !== "Product" || !isActiveSeat(current)) return "idle";
    this.groomer ??= new BacklogGroomer(this.store, team!.id, current.id, (cwd) => this.services.runtimeFor(cwd), {
      research: productResearchReader(this.store.runtimeDir), log: this.services.log, ...this.options,
    });
    return await this.groomer.tick();
  }
}

export function createProductRunner(services: ProductServices): ProductSeat { return new ProductSeat(services); }

/** The bridge's Lead grooming session gets its own journal while retaining the existing per-seat harness. */
export async function groomingRuntimeFor(store: PlanningStore, seatId: string): Promise<(cwd: string) => AgentRuntime> {
  const seats = ((await store.read()).teams as TeamRecord[]).flatMap((team) => team.seats);
  if (!seats.some((seat) => seat.id === seatId)) throw new Error("Unknown grooming seat.");
  const [engines, profiles] = await Promise.all([loadSeatEngines(store.runtimeDir, seats.map((seat) => seat.id)), loadSeatPersonas()]);
  const engine = Object.hasOwn(engines, seatId) ? engines[seatId] : "codex";
  const harness = seatHarnessDir(store.runtimeDir, seatId);
  const profile = Object.hasOwn(profiles, seatId) ? profiles[seatId] : undefined;
  return (cwd) => withPersonaRuntime(new SeatRuntime(engine, cwd, undefined, undefined, undefined, harness), profile);
}

/** Adapter invoked by each bridge poll. Starting preparation is asynchronous as well as the model turn. */
export function createLeadGrooming(store: PlanningStore, ownUserId: () => Promise<string>, runtimeFor = (seatId: string) => groomingRuntimeFor(store, seatId)) {
  const jobs = new Map<string, { groomer?: BacklogGroomer; starting?: Promise<void> }>();
  return async ({ teamId }: { teamId: string }): Promise<void> => {
    const job = jobs.get(teamId) ?? {};
    jobs.set(teamId, job);
    if (job.starting) return;
    job.starting = (async () => {
      const team = ((await store.read()).teams as TeamRecord[]).find((item) => item.id === teamId);
      if (!team?.mission?.trim()) return;
      const own = await ownUserId();
      const lead = team?.seats.find((seat) => seat.roles[0] === "Team Lead" && isActiveSeat(seat) && seat.externalIdentities.mattermost.userId === own);
      if (!lead) return;
      // Rebuild if the owner replaced the serving lead; an old runner will fail its active-seat check.
      const identity = `${teamId}/${lead.id}`;
      const seatJob = jobs.get(identity) ?? {};
      jobs.set(identity, seatJob);
      seatJob.groomer ??= new BacklogGroomer(store, teamId, lead.id, await runtimeFor(lead.id));
      seatJob.groomer.poll();
    })().catch(() => { /* Retry on the next poll; never propagate a research failure into workflow polling. */ }).finally(() => { job.starting = undefined; });
  };
}

/** Picked up by the CLI's optional ceremony-module wiring once the grooming hook is present. */
export function createCeremonyAdapters({ store, chat }: { store: PlanningStore; chat: Pick<PlanningChat, "ownUserId"> }): Pick<CeremonyAdapters, "grooming"> {
  return { grooming: createLeadGrooming(store, () => chat.ownUserId()) };
}

export const controlServices = ["grooming"] as const;
