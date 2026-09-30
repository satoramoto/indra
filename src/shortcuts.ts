import type { TerminalUiModel } from "./terminal-ui.js";

/**
 * The always-visible shortcut bar: the keys that apply right now, in plain words. It never names the terminal
 * multiplexer, and it stays on screen on every page, over the help and transcript, and while driving a session.
 */

export type ShortcutContext =
  | "teams" | "team"
  | "seat-seats" | "seat-session" | "seat-details" | "seat-sprints"
  | "connecting" | "driving"
  | "input" | "confirm" | "help" | "transcript";
export type Shortcut = [key: string, meaning: string];

export function shortcutContext(model: TerminalUiModel): ShortcutContext {
  if (model.input) return "input";
  if (model.confirm) return "confirm";
  if (model.overlay) return model.overlay;
  if (model.page === "teams") return "teams";
  if (model.page === "team") return "team";
  if (model.focus === "session" && model.driving) return model.drivingOn() ? "driving" : "connecting";
  return `seat-${model.focus}`;
}

const SEAT_COMMON: Shortcut[] = [["Tab", "next panel"], ["i", "drive session"], ["t", "transcript"], ["s", "restart"], ["x", "stop"], ["T", "retry"], ["b", "back"]];
const APP: Shortcut[] = [["?", "help"], ["q", "quit"]];

/** The shortcuts for a context. `extra` adds the page's own keys, such as the planning ceremony and `n`. */
export function shortcutsFor(context: ShortcutContext, extra: Shortcut[] = []): Shortcut[] {
  switch (context) {
    case "input": return [["Enter", "start the goal"], ["Esc", "cancel"]];
    case "confirm": return [["y", "confirm"], ["any other key", "cancel"]];
    case "help": return [["Esc  q  ?", "close help"]];
    case "transcript": return [["↑↓ PgUp PgDn", "scroll"], ["Home End", "start, or follow live"], ["Esc  q", "back"]];
    case "teams": return [["↑↓", "choose team"], ["Enter", "open"], ...extra, ["r", "check updates"], ...APP];
    case "team": return [["↑↓", "choose seat"], ["Enter", "open seat"], ["s", "restart"], ["x", "stop"], ["T", "retry"], ...extra, ["b", "teams"], ...APP];
    case "connecting": return [["Esc  Tab", "cancel"], ["", "checking for a headed run to drive…"]];
    case "driving": return [["", "your keys go to the session"], ["Esc Esc", "stop driving"], ["Tab", "next panel"], ["click outside", "stop driving"]];
    case "seat-seats": return [["↑↓", "choose seat"], ...SEAT_COMMON, ...extra, ...APP];
    case "seat-session": return [["Enter", "drive"], ["↑↓ PgUp PgDn", "scroll back"], ["End", "live"], ["Esc", "leave"], ["Tab", "next panel"], ["t", "transcript"], ["b", "back"], ...APP];
    case "seat-details":
    case "seat-sprints": return [["↑↓ PgUp PgDn", "scroll"], ...SEAT_COMMON, ...extra, ...APP];
  }
}

/** The shortcuts as one line of text, for tests and narrow screens. */
export const shortcutText = (shortcuts: Shortcut[]) => shortcuts.map(([key, meaning]) => key ? key + " " + meaning : meaning).join(" · ");
