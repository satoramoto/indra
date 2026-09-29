import type { MouseEvent } from "@opentui/core";
import { createEffect, createSignal, For, Index, Match, on, onCleanup, onMount, Switch, type Accessor } from "solid-js";
import { PROGRESS_MARK, STATUS, type ProgressKind } from "./codex-progress.js";
import { lineText, type MirrorLine, type MirrorStyle } from "./ansi-lines.js";
import { MirrorPoller, type MirrorFrame, type MirrorSeat, type SessionPort } from "./session-mirror.js";
import { GLYPH, PALETTE } from "./hub-style.js";

/** What a headless progress line is, for colouring. `plain` is anything that isn't a Codex progress line. */
export type PaneLineKind = Exclude<ProgressKind, "error"> | "git" | "fail" | "plain";
export interface PaneLine { time?: string; kind: PaneLineKind; text: string }

/** The hub's restrained palette: plain text for the run's words, dim for its asides, red only for a failure. */
export const PANE_LINE_COLOR: Record<PaneLineKind | "time", string> = {
  time: PALETTE.dim,
  purpose: PALETTE.accent,
  thinking: PALETTE.dim,
  agent: PALETTE.text,
  command: PALETTE.text,
  tool: PALETTE.text,
  git: PALETTE.text,
  files: PALETTE.text,
  info: PALETTE.dim,
  fail: PALETTE.bad,
  plain: PALETTE.text,
};

const KIND_BY_MARK = new Map<string, ProgressKind>(Object.entries(PROGRESS_MARK).map(([kind, mark]) => [mark, kind as ProgressKind]));
const PROGRESS_LINE = /^(\d{2}:\d{2}) (\S) (.*)$/;
const GIT = /^(?:cd \S+ && )?(?:[A-Za-z_][A-Za-z0-9_]*=\S* )*(?:git|gh)(?:\s|$)/;

/** Classifies one headless pane line by the mark `codex-progress` prints after the time. */
export function classifyPaneLine(line: string): PaneLine {
  const match = PROGRESS_LINE.exec(line);
  const kind = match ? KIND_BY_MARK.get(match[2]!) : undefined;
  if (!match || !kind) return { kind: "plain", text: line };
  const [, time, mark, rest] = match as unknown as [string, string, string, string];
  const text = `${mark} ${rest}`;
  if (kind === "error" || rest.startsWith(STATUS.failed)) return { time, kind: "fail", text };
  if (kind === "command" && GIT.test(rest.replace(/^\S+ /, ""))) return { time, kind: "git", text };
  return { time, kind, text };
}

/** The pane's colours: calm while watching, the accent when focused, and a warm colour while the owner drives. */
export const PANE_COLOR = {
  background: PALETTE.background, text: PALETTE.text, border: PALETTE.rule, focused: PALETTE.accent, driving: PALETTE.wait,
  title: PALETTE.accent, muted: PALETTE.dim, warn: PALETTE.wait, error: PALETTE.bad,
};

/** A span to draw: its text, and a style with the foreground always set. */
export interface DrawSpan { text: string; style: MirrorStyle & { fg: string } }

/**
 * One mirrored line as spans to draw. A line with no styling of its own (a headless run's progress output) is coloured
 * by its progress mark instead, as the progress view always was.
 */
export function styledLine(line: MirrorLine): DrawSpan[] {
  if (line.every((span) => !Object.keys(span.style).length)) {
    const plain = classifyPaneLine(lineText(line));
    return [...(plain.time ? [{ text: plain.time + " ", style: { fg: PANE_LINE_COLOR.time } }] : []), { text: plain.text || " ", style: { fg: PANE_LINE_COLOR[plain.kind] } }];
  }
  return line.map((span) => ({ text: span.text, style: { ...span.style, fg: span.style.fg ?? PANE_COLOR.text } }));
}

/** Rows inside the session pane on a screen `height` rows tall: what the header, details and shortcut bar leave. */
export function sessionPaneRows(height: number): number {
  return Math.max(6, Math.min(30, height - 26));
}

export type PaneMode = "watching" | "focused" | "connecting" | "driving";

export interface SessionPaneProps {
  source: Pick<SessionPort, "capture">;
  /** The seat to show, or undefined while the pane is hidden (nothing is captured then). */
  seat: Accessor<(MirrorSeat & { displayName?: string }) | undefined>;
  rows: Accessor<number>;
  width: Accessor<number>;
  scroll: Accessor<number>;
  mode: Accessor<PaneMode>;
  /** A click on the pane. */
  onFocus?: () => void;
  /** The mouse wheel over the pane: positive scrolls back. */
  onScroll?: (lines: number) => void;
  intervalMs?: number;
}

/**
 * The seat's live session inside Indra's layout, mirrored from its Indra-owned pane while this component is mounted
 * and `seat()` is defined. Each row keeps its own text renderable and only rows whose content changed are redrawn.
 */
export function SessionPane(props: SessionPaneProps) {
  const [frame, setFrame] = createSignal<{ seatId: string; frame: MirrorFrame }>();
  const poller = new MirrorPoller(props.source, () => props.seat(), () => ({ rows: props.rows(), width: props.width(), scroll: props.scroll() }), (seatId, value) => setFrame({ seatId, frame: value }), props.intervalMs);
  onMount(() => poller.start());
  onCleanup(() => poller.stop());
  // A new seat, size or scroll position is captured at once rather than on the next tick.
  createEffect(on(() => [props.seat()?.id, props.rows(), props.width(), props.scroll()], () => { void poller.tick(); }, { defer: true }));
  const current = () => { const value = frame(); return value && value.seatId === props.seat()?.id ? value.frame : undefined; };
  // Rows keep their StyledText while their text and style are unchanged, so Index redraws only the rows that changed.
  let previous: { key: string; spans: DrawSpan[] }[] = [];
  const rows = () => {
    const value = current();
    const lines = value?.status === "ok" ? value.lines : [];
    previous = lines.map((line, index) => {
      const key = JSON.stringify(line);
      return previous[index]?.key === key ? previous[index]! : { key, spans: styledLine(line) };
    });
    return previous;
  };
  const name = () => props.seat()?.displayName ?? props.seat()?.id ?? "";
  const headed = () => { const value = current(); return value?.status === "ok" ? value.headed : undefined; };
  const title = () => {
    const mode = props.mode();
    if (mode === "driving") return ` DRIVING ${name()} — Esc Esc or Tab to stop `;
    if (mode === "connecting") return ` ${name()} ${GLYPH.separator} connecting… `;
    const kind = headed() ? `headed ${headed() === "claude" ? "Claude" : "Codex"}` : "progress";
    const scrolled = props.scroll() ? ` ${GLYPH.separator} ${props.scroll()} lines back ${GLYPH.separator} End live` : "";
    return ` LIVE ${GLYPH.separator} ${name()} ${GLYPH.separator} ${kind} ${GLYPH.separator} ${mode === "focused" ? "watching" : "click or i to drive"}${scrolled} `;
  };
  const border = () => props.mode() === "driving" ? PANE_COLOR.driving : props.mode() === "watching" ? PANE_COLOR.border : PANE_COLOR.focused;
  return (
    <box id="session-pane" flexDirection="column" flexShrink={0} height={props.rows() + 2} backgroundColor={PANE_COLOR.background}
      border borderColor={border()} title={title()} titleColor={props.mode() === "driving" ? PANE_COLOR.driving : PANE_COLOR.title}
      onMouseDown={(event: MouseEvent) => { event.stopPropagation(); props.onFocus?.(); }}
      onMouseScroll={(event: MouseEvent) => {
        event.stopPropagation();
        const direction = event.scroll?.direction;        if (direction === "up" || direction === "down") props.onScroll?.((direction === "up" ? 1 : -1) * Math.max(1, event.scroll?.delta ?? 1));
      }}>
      <Switch fallback={<text fg={PANE_COLOR.muted}>Reading the session…</text>}>
        <Match when={current()?.status === "no-session"}><text fg={PANE_COLOR.warn}>No live session: this seat's process is not running under Indra.</text></Match>
        <Match when={current()?.status === "error"}><text fg={PANE_COLOR.error}>{"Could not read the session: " + ((current() as { message?: string } | undefined)?.message ?? "")}</text></Match>
        <Match when={current()?.status === "ok"}>
          <Index each={rows()}>{(row) => (
            <text flexShrink={0} height={1} wrapMode="none">
              <For each={row().spans}>{(span) => <span style={span.style}>{span.text}</span>}</For>
            </text>
          )}</Index>
        </Match>
      </Switch>
    </box>
  );
}
