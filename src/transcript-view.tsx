import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import type { TranscriptEntry, TranscriptKind, TranscriptLocation, TranscriptSeat, TranscriptSource } from "./session-transcript.js";

/** Entries kept on screen; older ones drop off the top. */
export const TRANSCRIPT_ENTRY_CAP = 1500;

export const TRANSCRIPT_COLOR: Record<TranscriptKind, string> = {
  user: "#FDE68A", assistant: "#F9FAFB", thinking: "#7C8799", tool: "#93C5FD", result: "#9CA3AF", error: "#FCA5A5",
};

const engineName = (engine: TranscriptLocation["engine"]) => engine === "claude" ? "Claude Code" : "Codex";

function clock(at: string | undefined): string {
  const time = at ? new Date(at) : undefined;
  return time && !Number.isNaN(time.getTime()) ? time.toTimeString().slice(0, 8) + " " : "";
}

export interface TranscriptViewProps {
  source?: TranscriptSource;
  seat: TranscriptSeat & { displayName?: string };
  /** The session Indra recorded for the seat, if any (Chick's planning session). */
  recordedHandle: () => string | undefined;
  intervalMs?: number;
}

/**
 * A full-screen, read-only view of the seat's current engine session that follows it live. It reads the engine's own
 * log through `source` about once a second while open, and stops when closed. Esc or q (handled by the model) closes it.
 */
export function TranscriptView(props: TranscriptViewProps) {
  const [entries, setEntries] = createSignal<TranscriptEntry[]>([]);
  const [location, setLocation] = createSignal<TranscriptLocation>();
  const [status, setStatus] = createSignal<"reading" | "none" | "error" | "ok">("reading");
  const [message, setMessage] = createSignal("");
  let scroll: ScrollBoxRenderable | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  let open = true;
  const feed = props.source?.feed(props.seat, props.recordedHandle);

  const tick = async () => {
    if (!feed || busy || !open) return;
    busy = true;
    try {
      const result = await feed.poll();
      if (!open) return;
      if (result.status !== "ok") { setStatus(result.status); if (result.status === "error") setMessage(result.message); return; }
      setStatus("ok");
      setLocation(result.location);
      if (result.reset) setEntries(result.entries.slice(-TRANSCRIPT_ENTRY_CAP));
      else if (result.entries.length) setEntries((current) => [...current, ...result.entries].slice(-TRANSCRIPT_ENTRY_CAP));
    } finally { busy = false; }
  };
  onMount(() => {
    if (!feed) { setStatus("error"); setMessage("Transcripts cannot be read from this screen."); return; }
    void tick();
    timer = setInterval(() => { void tick(); }, props.intervalMs ?? 1000);
  });
  onCleanup(() => { open = false; if (timer) clearInterval(timer); });

  useKeyboard((key) => {
    if (!scroll) return;
    if (key.name === "up" || key.name === "k") scroll.scrollBy(-1);
    else if (key.name === "down" || key.name === "j") scroll.scrollBy(1);
    else if (key.name === "pageup" || key.name === "pagedown") scroll.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
    else if (key.name === "home") scroll.scrollTo(0);
    else if (key.name === "end") scroll.scrollTo(scroll.scrollHeight);
  });

  const title = () => {
    const where = location();
    return "TRANSCRIPT · " + (props.seat.displayName ?? props.seat.id)
      + (where ? " · " + engineName(where.engine) + " session " + where.sessionId.slice(0, 8) : "") + " · read-only · Esc/q back";
  };
  return (
    <box position="absolute" top={0} left={0} width="100%" height="100%" zIndex={20} padding={1} backgroundColor="#0B1220">
      <scrollbox ref={scroll} flexGrow={1} scrollY stickyScroll stickyStart="bottom" border borderColor="#42536B" title={title()} titleColor="#67E8F9" paddingLeft={1} paddingRight={1}>
        <Switch>
          <Match when={status() === "reading"}><text fg="#9CA3AF">Reading the session log…</text></Match>
          <Match when={status() === "none"}><text fg="#FDE68A" wrapMode="word">No session log found for this seat yet. It appears here once the seat's engine starts a session.</text></Match>
          <Match when={status() === "error"}><text fg="#FCA5A5" wrapMode="word">Transcript unavailable: {message()}</text></Match>
          <Match when={status() === "ok"}>
            <For each={entries()} fallback={<text fg="#9CA3AF">(nothing in this session yet)</text>}>{(item) => (
              <box flexDirection="column" flexShrink={0} paddingBottom={1}>
                <text fg={TRANSCRIPT_COLOR[item.kind]}>{clock(item.at) + item.label}</text>
                <Show when={item.text}><text fg={item.kind === "assistant" ? "#E5E7EB" : TRANSCRIPT_COLOR[item.kind]} wrapMode="word">{item.text}</text></Show>
              </box>
            )}</For>
          </Match>
        </Switch>
      </scrollbox>
    </box>
  );
}
