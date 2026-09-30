/** Deterministic, bounded digest of an archived retro for agent prompts. Pure: no I/O. */
import type { GoalRetrospective } from "./goal-contract.js";

export const RETRO_DIGEST_CHARS = 4000;
export const retroDigestPointer = (path: string) => `[digest truncated; full retro at ${path}]`;

const SECTIONS = ["Owner proposals", "What went poorly", "What went well", "Process phases", "Review findings"] as const;
type Section = (typeof SECTIONS)[number];
interface Phase { heading: string; bullets: string[] }

const PHASES: Section = "Process phases";
const LEVEL2 = /^## (.+?)(?: \[[^\]]*\])?$/;
const LEVEL3 = /^### (.+)$/;
const isSection = (name: string): name is Section => (SECTIONS as readonly string[]).includes(name);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isHeading = (line: string) => line.startsWith("## ") || line.startsWith("### ");
const pointerPath = (retro: GoalRetrospective) => nonEmpty(retro?.path) ? retro.path : nonEmpty(retro?.goalId) ? `docs/retros/${retro.goalId}.md` : "(unknown path)";

function clip(text: string, room: number): string {
  let out = "";
  for (const char of text) {
    if (out.length + char.length > room) break;
    out += char;
  }
  return out.trimEnd();
}

function digestLines(lines: string[]): string[] | null {
  const bullets = new Map<Section, string[]>();
  const phases: Phase[] = [];
  let current: Section | null = null;
  let phase: Phase | null = null;
  let recognized = false;
  for (const line of lines) {
    const level2 = LEVEL2.exec(line);
    if (level2) {
      const name = level2[1].trim();
      current = isSection(name) ? name : null;
      phase = null;
      recognized ||= current !== null;
      continue;
    }
    if (current === PHASES) {
      if (LEVEL3.test(line)) phases.push(phase = { heading: line, bullets: [] });
      else if (phase && line.startsWith("- ")) phase.bullets.push(line);
    } else if (current && line.startsWith("- ")) bullets.set(current, [...(bullets.get(current) ?? []), line]);
  }
  if (!recognized) return null;
  return SECTIONS.flatMap((name) => {
    const body = name === PHASES
      ? phases.filter((group) => group.bullets.length > 0).flatMap((group) => [group.heading, ...group.bullets])
      : bullets.get(name) ?? [];
    return body.length > 0 ? [`## ${name}`, ...body] : [];
  });
}

function capped(lines: string[], pointer: string): string {
  const budget = RETRO_DIGEST_CHARS - pointer.length - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const join = kept.length > 0 ? 1 : 0;
    if (used + join + line.length <= budget) {
      kept.push(line);
      used += join + line.length;
      continue;
    }
    const room = budget - used - join;
    if (room >= 80) {
      const cut = clip(line, room - 1);
      if (cut) kept.push(`${cut}…`);
    }
    break;
  }
  while (kept.length > 0 && isHeading(kept[kept.length - 1])) kept.pop();
  return kept.length > 0 ? `${kept.join("\n")}\n${pointer}` : pointer;
}

export function retroDigest(retro: GoalRetrospective): string {
  let pointer = retroDigestPointer("(unknown path)");
  try {
    pointer = retroDigestPointer(pointerPath(retro));
    const summary = typeof retro.summary === "string" ? retro.summary.replace(/\r\n?/g, "\n") : "";
    const lines = digestLines(summary.split("\n").map((line) => line.trimEnd()));
    if (!lines) {
      const text = summary.trim();
      const head = text ? clip(text, RETRO_DIGEST_CHARS - pointer.length - 1) : "";
      return head ? `${head}\n${pointer}` : pointer;
    }
    if (lines.length === 0) return pointer;
    const full = lines.join("\n");
    return full.length <= RETRO_DIGEST_CHARS ? full : capped(lines, pointer);
  } catch {
    return pointer;
  }
}
