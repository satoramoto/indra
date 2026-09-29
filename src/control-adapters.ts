/// <reference types="vite/client" />
import type { AgentStatePort, OwnerSettingsPort } from "./autonomy-ports.js";
import type { AgentRuntime } from "./codex-runtime.js";
import type { CeremonyWriteReadiness } from "./ceremony-ports.js";
import type { PlanningGoal, PlanningStore } from "./planning.js";
import type { CeremonyAdapters, PlanningChat } from "./planning-bridge.js";
import type { ReleaseActivationOptions, ReleaseActivationReadPort } from "./release-activation.js";
import type { SeatRecord, SeatRole, StateTeam, TeamRecord } from "./state-domain.js";
import type { SeatProcessPort } from "./supervisor.js";

export interface AddSeatRequest { teamId: string; displayName: string; username: string; role: SeatRole }
export interface RemoveSeatRequest { teamId: string; seatId: string; expected: SeatRecord }
/** Lifecycle adapters own persistence, identity verification and safe retirement, including transaction rechecks. */
export interface SeatLifecycleControls {
  add(request: AddSeatRequest): Promise<void>;
  remove(request: RemoveSeatRequest): Promise<void>;
  /** Retry pending credentials and retirement between UI polls; no credential value is returned. */
  reconcile(): Promise<void>;
}
export interface OwnerControlPorts {
  settings?: OwnerSettingsPort;
  lifecycle?: SeatLifecycleControls;
  /** Only the completed policy/automation adapter supplies enable. Off always uses the owner settings port. */
  autoMode?: { enable(teamId: string): Promise<void> };
}
export type WorkflowService = "grooming" | "policy" | "releaseFacts" | "nextSprint";
export interface OwnerControls extends OwnerControlPorts {
  available?: Partial<Record<WorkflowService | "product", boolean>>;
}
export interface OwnerControlServices { store: PlanningStore; processes: SeatProcessPort; appDir: string }
export interface BridgeAdapterServices {
  store: PlanningStore; runtime: AgentRuntime; appDir: string; chat: PlanningChat;
  /** Goes through the bridge's existing team/home, open-goal and delivery checks. */
  start(goal: string, participants?: string[]): Promise<PlanningGoal>;
}
export interface ProductRunner { tick(): Promise<"idle" | "worked"> }
export interface ProductRunnerServices {
  /** Agent-facing state cannot mutate mission or policy. Runtime metadata remains outside Git. */
  store: AgentStatePort & Pick<PlanningStore, "runtimeDir" | "readRuntimeFile" | "saveRuntime">;
  team: TeamRecord; seat: SeatRecord; chat: PlanningChat;
  runtimeFor(cwd: string): AgentRuntime;
  log(line: string): void;
}

/** Optional factories have no import-time effects. Later outcomes register here by exporting from their own files. */
export interface ControlAdapterModule {
  LocalReleaseActivationReader?: new (checkout: string, options?: ReleaseActivationOptions) => ReleaseActivationReadPort;
  ceremonyReadiness?: CeremonyWriteReadiness;
  createCeremonyAdapters?(services: BridgeAdapterServices): CeremonyAdapters | Promise<CeremonyAdapters>;
  createOwnerControls?(services: OwnerControlServices): OwnerControlPorts | Promise<OwnerControlPorts>;
  createProductRunner?(services: ProductRunnerServices): ProductRunner | Promise<ProductRunner>;
  /** UI status only; declaring a service never grants approval or calls a factory. */
  controlServices?: readonly WorkflowService[];
}
export type ControlModules = Record<string, ControlAdapterModule>;
export const controlModules = import.meta.glob<ControlAdapterModule>([
  "./release-activation.ts", "./retro-publication.ts", "./integration-review.ts",
  "./seat-lifecycle.ts", "./seat-provisioning.ts", "./product-seat.ts", "./backlog-groomer.ts",
  "./owner-settings.ts", "./auto-policy.ts", "./auto-mode-adapter.ts", "./release-facts.ts", "./next-sprint.ts",
], { eager: true });

export function productRunnerFactory(modules: ControlModules = controlModules): ControlAdapterModule["createProductRunner"] {
  const factories = Object.values(modules).flatMap((module) => "createProductRunner" in module && module.createProductRunner ? [module.createProductRunner] : []);
  if (factories.length > 1) throw new Error("Multiple adapters provide the Product runner.");
  return factories[0];
}

export async function createOwnerControls(services: OwnerControlServices, modules: ControlModules = controlModules): Promise<OwnerControls> {
  const controls: OwnerControls = { available: { product: !!productRunnerFactory(modules) } };
  for (const module of Object.values(modules)) {
    const supplied = "createOwnerControls" in module ? await module.createOwnerControls?.(services) : undefined;
    for (const key of ["settings", "lifecycle", "autoMode"] as const) if (supplied?.[key]) {
      if (controls[key]) throw new Error(`Multiple owner control adapters provide ${key}.`);
      Object.assign(controls, { [key]: supplied[key] });
    }
    if ("createCeremonyAdapters" in module && module.createCeremonyAdapters && "controlServices" in module) {
      for (const name of module.controlServices ?? []) controls.available![name] = true;
    }
  }
  controls.settings ??= { updateOwnerSettings: (teamId, patch, at) => services.store.updateOwnerSettings(teamId, patch, at) };
  return controls;
}

/** Preserve every typed bridge hook, and refuse ambiguous ownership instead of silently replacing a gate. */
export function registerCeremonyAdapters(target: CeremonyAdapters, supplied?: CeremonyAdapters): void {
  for (const key of Object.keys(supplied ?? {}) as (keyof CeremonyAdapters)[]) if (supplied![key]) {
    if (target[key]) throw new Error(`Multiple ceremony adapters provide ${key}.`);
    Object.assign(target, { [key]: supplied![key] });
  }
}

/** Stable identity for a retirement confirmation; display order and runtime activity do not change it. */
export function removalRequest(team: StateTeam, seatId: string): RemoveSeatRequest | undefined {
  const seat = team.seats.find((item) => item.id === seatId);
  if (!seat) return;
  return { teamId: team.id, seatId, expected: {
    id: seat.id, displayName: seat.displayName, roles: seat.roles as SeatRole[], status: seat.status,
    externalIdentities: { mattermost: { username: seat.handle, ...(seat.mattermostUserId ? { userId: seat.mattermostUserId } : {}) } },
  } };
}
