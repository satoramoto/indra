import { For } from "solid-js";
import { PALETTE } from "./hub-style.js";

export interface HelpSection { title: string; keys: [key: string, meaning: string][] }

/** Every key the terminal UI takes, in plain words. `?` shows it; Esc, q or ? closes it. */
export const HELP_SECTIONS: HelpSection[] = [
  { title: "Moving around", keys: [
    ["↑ ↓  j k", "choose a team or seat"],
    ["Enter  →", "open it"],
    ["b  ←  Esc", "go back"],
    ["PgUp PgDn", "scroll the page"],
    ["mouse wheel", "scrolls whatever is under the pointer"],
  ] },
  { title: "A seat", keys: [
    ["Tab  Shift-Tab", "move between the seat list, the live session, the details and the sprints"],
    ["click", "focus that part; the focused part has a bright border"],
    ["↑ ↓", "in the seat list, show another seat; elsewhere, scroll the focused part"],
    ["i  or click the session", "drive the seat's live agent session: your keys reach it (only during a headed run; otherwise you watch)"],
    ["t", "read the seat's session transcript as it happens (read-only)"],
    ["s  x", "restart or stop the seat's process"],
    ["T", "retry a failed assignment (asks first)"],
  ] },
  { title: "The live session", keys: [
    ["watching", "the session shows beside the seat list all the time; nothing you type reaches it"],
    ["↑ ↓ PgUp PgDn  wheel", "scroll back while it is focused; End returns to live"],
  ] },
  { title: "While driving a session", keys: [
    ["typing", "goes straight to the live agent session, Ctrl-C and a single Esc included"],
    ["Esc Esc", "stop driving (two quick presses)"],
    ["Tab", "stop driving and move to the next part"],
    ["click outside", "stop driving"],
    ["", "the task keeps running and Indra still waits for its result"],
  ] },
  { title: "In the transcript", keys: [
    ["↑ ↓  PgUp PgDn", "scroll"],
    ["Home  End", "jump to the start, or back to following live"],
    ["Esc  q", "back"],
  ] },
  { title: "Planning, on Chick's seat", keys: [
    ["n", "start a new planning goal"],
    ["P  A", "request or approve a proposal (asks first)"],
    ["I  V", "integrate historical work or roll back a sprint (asks first)"],
  ] },
  { title: "Indra", keys: [
    ["r", "check for updates now"],
    ["U  R", "pause or resume auto-update; roll back to the previous build"],
    ["?", "this help"],
    ["q", "quit; seat processes keep running"],
    ["closing the window", "Indra keeps running; npm start brings it back"],
  ] },
];

export function HelpOverlay() {
  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={20} padding={1} backgroundColor={PALETTE.background}>
      <scrollbox flexGrow={1} scrollY border borderColor={PALETTE.rule} title=" HELP · Esc, q or ? closes " titleColor={PALETTE.accent} paddingLeft={1} paddingRight={1}>
        <For each={HELP_SECTIONS}>{(section) => (
          <box flexDirection="column" flexShrink={0} paddingBottom={1}>
            <text fg={PALETTE.text}>{section.title.toUpperCase()}</text>
            <For each={section.keys}>{([key, meaning]) => (
              <box flexDirection="row" flexShrink={0}>
                <text fg={PALETTE.accent} width={26} flexShrink={0}>{"  " + key}</text>
                <text fg={PALETTE.dim} wrapMode="word">{meaning}</text>
              </box>
            )}</For>
          </box>
        )}</For>
      </scrollbox>
    </box>
  );
}
