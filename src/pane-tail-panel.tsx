import { createEffect, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type Accessor } from "solid-js";
import { PROGRESS_MARK, STATUS, type ProgressKind } from "./codex-progress.js";
import { PaneTailPoller, type PaneTail, type PaneTailSeat, type PaneTailSource } from "./pane-tail.js";

export interface PaneTailPanelProps {
  source: PaneTailSource;
  seat: Accessor<(PaneTailSeat & { displayName?: string }) | undefined>;
  /** Characters per line inside the panel. */
  width: Accessor<number>;
  /** Lines of the pane to show. */
  lines: Accessor<number>;
  intervalMs?: number;
}

/** How many pane lines fit: a third of the rows left after the header and footer, kept between 8 and 15. */
export function paneTailLines(height: number): number {
  return Math.max(8, Math.min(15, Math.floor((height - 12) / 2)));
}

/** What a pane line is, for colouring. `plain` is anything that isn't a Codex progress line. */
export type PaneLineKind = Exclude<ProgressKind, "error"> | "git" | "fail" | "plain";
export interface PaneLine { time?: string; kind: PaneLineKind; text: string }

export const PANE_LINE_COLOR: Record<PaneLineKind | "time", string> = {
  time: "#6B7280",
  purpose: "#67E8F9",
  thinking: "#7C8799",
  agent: "#F9FAFB",
  command: "#93C5FD",
  tool: "#93C5FD",
  git: "#FDBA74",
  files: "#86EFAC",
  info: "#9CA3AF",
  fail: "#FCA5A5",
  plain: "#E5E7EB",
};

const KIND_BY_MARK = new Map<string, ProgressKind>(Object.entries(PROGRESS_MARK).map(([kind, mark]) => [mark, kind as ProgressKind]));
const PROGRESS_LINE = /^(\d{2}:\d{2}) (\S) (.*)$/;
const GIT = /^(?:cd \S+ && )?(?:[A-Za-z_][A-Za-z0-9_]*=\S* )*(?:git|gh)(?:\s|$)/;

/** Classifies one sanitized pane line by the mark `codex-progress` prints after the time. */
export function classifyPaneLine(line: string): PaneLine {
  const match = PROGRESS_LINE.exec(line);
  const kind = match ? KIND_BY_MARK.get(match[2]) : undefined;
  if (!match || !kind) return { kind: "plain", text: line };
  const [, time, mark, rest] = match;
  const text = `${mark} ${rest}`;
  if (kind === "error" || rest.startsWith(STATUS.failed)) return { time, kind: "fail", text };
  if (kind === "command" && GIT.test(rest.replace(/^\S+ /, ""))) return { time, kind: "git", text };
  return { time, kind, text };
}

/**
 * A live, read-only view of the last lines of the selected seat's Indra-owned tmux pane. It captures only while
 * mounted: the timer starts when the panel appears and stops when it is removed.
 */
export function PaneTailPanel(props: PaneTailPanelProps) {
  const [tail, setTail] = createSignal<{ seatId: string; tail: PaneTail }>();
  const poller = new PaneTailPoller(props.source, () => props.seat(), () => ({ lines: props.lines(), width: props.width() }), (seatId, value) => setTail({ seatId, tail: value }), props.intervalMs);
  onMount(() => poller.start());
  onCleanup(() => poller.stop());
  // A new seat shows its own pane at once instead of the previous seat's lines.
  createEffect(on(() => props.seat()?.id, () => { void poller.tick(); }, { defer: true }));
  const current = () => { const value = tail(); return value && value.seatId === props.seat()?.id ? value.tail : undefined; };
  const clip = (text: string) => { const chars = Array.from(text); const width = Math.max(1, props.width()); return chars.length <= width ? text : chars.slice(0, width - 1).join("") + "…"; };
  return (
    <box flexDirection="column" flexShrink={0} height={props.lines() + 2} paddingLeft={1} paddingRight={1} backgroundColor="#0B1220" border borderColor="#42536B" title={"LIVE PANE · " + clip(props.seat()?.displayName ?? props.seat()?.id ?? "")} titleColor="#67E8F9">
      <Switch fallback={<text fg="#9CA3AF">Reading pane…</text>}>
        <Match when={current()?.status === "no-session"}><text fg="#FDE68A">no session</text></Match>
        <Match when={current()?.status === "error"}><text fg="#FCA5A5">{clip("Pane read failed: " + ((current() as { message?: string } | undefined)?.message ?? ""))}</text></Match>
        <Match when={current()?.status === "ok"}>
          <For each={(current() as { lines?: string[] } | undefined)?.lines ?? []} fallback={<text fg="#9CA3AF">(pane is empty)</text>}>{(raw) => {
            const line = classifyPaneLine(raw);
            return (
              <box flexDirection="row" flexShrink={0} height={1}>
                <Show when={line.time}><text fg={PANE_LINE_COLOR.time} flexShrink={0}>{line.time + " "}</text></Show>
                <text fg={PANE_LINE_COLOR[line.kind]}>{line.text || " "}</text>
              </box>
            );
          }}</For>
        </Match>
      </Switch>
    </box>
  );
}
