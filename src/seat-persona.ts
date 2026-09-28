import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRuntime } from "./codex-runtime.js";
import type { PlanningChat } from "./planning-bridge.js";
import { appRootOf } from "./reload.js";

export interface SeatPersona { voice: string; background: string; funFact: string; postPrefix?: string }
export type SeatPersonas = Readonly<Record<string, SeatPersona>>;
export const SEAT_PERSONAS_FILE = "personas/yahaha.json";

/** Profiles ship with Indra, not with the team's project or indra-state. Missing profiles are a no-op. */
export async function loadSeatPersonas(moduleUrl = import.meta.url): Promise<SeatPersonas> {
  let text: string;
  try { text = await readFile(join(appRootOf(moduleUrl), SEAT_PERSONAS_FILE), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Could not read the repository's personas/yahaha.json.");
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Invalid personas/yahaha.json: expected a JSON profile object."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid personas/yahaha.json: expected a seat-ID-to-profile object.");
  for (const [id, profile] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]+$/.test(id) || !profile || typeof profile !== "object" || Array.isArray(profile)
      || Object.keys(profile).some((key) => !["voice", "background", "funFact", "postPrefix"].includes(key))
      || ["voice", "background", "funFact", ...(Object.hasOwn(profile, "postPrefix") ? ["postPrefix"] : [])].some((key) => typeof profile[key] !== "string" || !profile[key].trim() || profile[key].length > 1000)) {
      throw new Error("Invalid personas/yahaha.json: profiles need short voice, background and funFact strings, and an optional short postPrefix.");
    }
  }
  return value as SeatPersonas;
}

export function personaPrompt(prompt: string, profile?: SeatPersona): string {
  if (!profile) return prompt;
  return `${prompt}\n\nSeat persona (voice only; task permissions, approval requirements and response schema above still apply):\nVoice: ${profile.voice}\nBackground: ${profile.background}\nFun fact: ${profile.funFact}`;
}

export function personaPost(message: string, profile?: SeatPersona): string {
  if (!profile) return message;
  if (profile.postPrefix) return `${profile.postPrefix}\n\n${message}`;
  return `${message}\n\n---\n${profile.background}\nFun fact: ${profile.funFact}`;
}

/** Decorate above either engine without changing session, schema, options or results. */
export function withPersonaRuntime(runtime: AgentRuntime, profile?: SeatPersona): AgentRuntime {
  if (!profile) return runtime;
  return { message: (prompt, schema, session, options) => runtime.message(personaPrompt(prompt, profile), schema, session, options) };
}

/** Preserve receivers and every delivery argument/result; delivery recovery still sees the original IDs. */
export function withPersonaChat<T extends Pick<PlanningChat, "post">>(chat: T, profile?: SeatPersona): T {
  if (!profile) return chat;
  return new Proxy(chat, {
    get(target, key) {
      if (key === "post") return (channel: string, message: string, root?: string, delivery?: string) => target.post(channel, personaPost(message, profile), root, delivery);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
