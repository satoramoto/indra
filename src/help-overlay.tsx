import { For } from "solid-js";
import { RETURN_KEY } from "./watch-keys.js";
import { PALETTE } from "./hub-style.js";

export interface HelpSection { title: string; keys: [key: string, meaning: string][] }

/** Every key the terminal UI takes, in plain words. `?` shows it; Esc, q or ? closes it. */
export const HELP_SECTIONS: HelpSection[] = [
  { title: "Moving around", keys: [
    ["↑ ↓  j k", "choose a team or seat"],
    ["Enter  →", "open it"],
    ["b  ←  Esc", "go back"],
    ["PgUp PgDn", "scroll the page"],
  ] },
  { title: "A seat", keys: [
    ["a", "watch the seat's live process (read-only)"],
    ["D", "drive the seat's live agent session: your keys reach it (only during a headed run; otherwise it watches)"],
    ["t", "read the seat's session transcript as it happens (read-only)"],
    ["s  x", "restart or stop the seat's process"],
    ["T", "retry a failed assignment (asks first)"],
  ] },
  { title: "While watching a seat", keys: [
    [RETURN_KEY, "back to Indra"],
    ["wheel  PgUp", "scroll back; q, Esc or scrolling to the bottom returns to live"],
    ["typing", "never reaches the run"],
  ] },
  { title: "While driving a seat", keys: [
    [RETURN_KEY, "back to Indra; the task keeps running and Indra still waits for its result"],
    ["typing", "goes straight to the live agent session"],
  ] },
  { title: "In the transcript", keys: [
    ["↑ ↓  PgUp PgDn", "scroll"],
    ["Home  End", "jump to the start, or back to following live"],
    ["Esc  q", "back"],
  ] },
  { title: "Planning, on Chick's seat", keys: [
    ["n", "start a new planning goal"],
    ["P  A", "request or approve a proposal (asks first)"],
    ["I  M  V", "integrate, merge or revert a sprint (asks first)"],
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
                <text fg={PALETTE.accent} width={20} flexShrink={0}>{"  " + key}</text>
                <text fg={PALETTE.dim} wrapMode="word">{meaning}</text>
              </box>
            )}</For>
          </box>
        )}</For>
      </scrollbox>
    </box>
  );
}
