import { automaticGate } from "./auto-mode.js";
import { OwnerSettingsCommands } from "./owner-settings.js";
import type { BridgeAdapterServices, OwnerControlPorts, OwnerControlServices } from "./control-adapters.js";
import type { CeremonyAdapters } from "./planning-bridge.js";
import { loadSeatPersonas } from "./seat-persona.js";

export const controlServices = ["policy"] as const;

/** Discovered by the existing bridge composition; installing the adapter does not enable a policy. */
export async function createCeremonyAdapters({ chat }: Pick<BridgeAdapterServices, "chat">): Promise<CeremonyAdapters> {
  const profiles = await loadSeatPersonas(import.meta.url);
  return { automaticGate: (context, request) => automaticGate(context, request, chat, profiles) };
}

/** Only the owner TUI receives this capability. Enabling still requires an explicitly selected owner scope. */
export function createOwnerControls({ store }: Pick<OwnerControlServices, "store">): OwnerControlPorts {
  const commands = new OwnerSettingsCommands(store);
  return { autoMode: { enable: (teamId) => commands.enable(teamId) } };
}
