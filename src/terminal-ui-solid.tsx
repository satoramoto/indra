import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import type { StateInventory, StateSeat } from "./state-domain.js";
import { attachTmux } from "./tmux-attach.js";
import { currentSession, displayText, newestPlanningRecord, TerminalUiModel, type SessionReadPort, type TerminalSession } from "./terminal-ui.js";

const theme = {
  background: "#111827", panel: "#1F2937", selected: "#243B53",
  heading: "#E9D5FF", accent: "#67E8F9", regular: "#E5E7EB",
  muted: "#9CA3AF", running: "#86EFAC", idle: "#FDE68A", error: "#FCA5A5",
};

function occupancy(model: TerminalUiModel, seat: StateSeat): { label: string; color: string; session?: TerminalSession } {
  const records = model.sessionsFor(seat.id);
  const session = currentSession(records);
  const newest = newestPlanningRecord(records);
  if (model.sessionResult.connection !== "connected") return { label: "OCCUPANCY UNKNOWN", color: theme.idle, session: newest };
  if (newest?.status === "error" && !newest.sessionId) return { label: records.some((record) => !!record.sessionId) ? "RUNTIME ERROR · SAVED SESSION" : "RUNTIME RECORD ERROR", color: theme.error, session: newest };
  if (!session?.sessionId) return { label: "NO ACTIVE SESSION", color: theme.idle, session };
  return {
    label: session.status.toUpperCase() + " SESSION · " + session.engine,
    color: session.status === "error" ? theme.error : session.status === "running" ? theme.running : theme.idle,
    session,
  };
}

function activityLine(model: TerminalUiModel, seat: StateSeat, limit: number): string {
  const session = newestPlanningRecord(model.sessionsFor(seat.id));
  if (!session) return model.sessionResult.connection === "connected" ? "No recent runtime activity." : "Live activity unavailable.";
  const latest = session.recentActivity.at(-1);
  if (latest) return (model.sessionResult.connection === "connected" ? "Latest: " : "Recorded: ") + displayText(latest, limit);
  return "Planning goal: " + displayText(session.goal, limit) + " · stage: " + displayText(session.stage, 30);
}

export interface TerminalAppProps {
  model: TerminalUiModel;
  revision: Accessor<number>;
  onKey: (name: string, ctrl?: boolean) => void;
}

export function TerminalApp(props: TerminalAppProps) {
  const dimensions = useTerminalDimensions();
  const page = createMemo(() => { props.revision(); return props.model.page; });
  const team = createMemo(() => { props.revision(); return props.model.team; });
  const seat = createMemo(() => { props.revision(); return props.model.seat; });
  const wide = createMemo(() => dimensions().width >= 105);
  const runtime = createMemo(() => {
    props.revision();
    const connection = props.model.sessionResult.connection;
    return connection === "connected" ? "RUNTIME CONNECTED" : connection === "error" ? "RUNTIME ERROR" : "RUNTIME DISCONNECTED";
  });
  const stateSummary = createMemo(() => {
    props.revision();
    return props.model.stateError
      ? "STATE ERROR · " + displayText(props.model.stateError)
      : "State loaded " + (displayText(props.model.refreshedAt) || "pending");
  });
  const notice = createMemo(() => { props.revision(); return props.model.notice; });

  useKeyboard((key) => props.onKey(key.name, key.ctrl));

  const seatDetail = () => {
    props.revision();
    const selected = seat();
    if (!selected) return <text fg={theme.muted}>Select a seat to inspect its runtime.</text>;
    const state = occupancy(props.model, selected);
    const sessions = props.model.sessionsFor(selected.id);
    return (
      <box flexDirection="column" gap={1} padding={1} backgroundColor={theme.panel} border borderColor="#42536B" title="SEAT DETAIL" titleColor={theme.accent}>
        <text fg={theme.heading}>{displayText(selected.displayName)}  @{displayText(selected.handle)}</text>
        <text fg={theme.regular}>Role: {displayText(selected.roles.join(", ") || "none")}</text>
        <text fg={state.color}>{state.label}</text>
        <Show when={props.model.sessionResult.connection !== "connected"}>
          <text fg={theme.idle}>{displayText(props.model.sessionResult.message) || "Session reader unavailable."}</text>
        </Show>
        <For each={sessions}>{(session) => (
          <box flexDirection="column" gap={0}>
            <text fg={theme.accent}>Planning goal: {displayText(session.goal, 160)}</text>
            <text fg={theme.regular}>Stage: {displayText(session.stage)}  ·  {props.model.sessionResult.connection === "connected" ? "Codex session" : "Last Codex session"}: {displayText(session.sessionId) || "not started"}</text>
            <text fg={theme.muted}>Updated: {displayText(session.updatedAt) || "not reported"}</text>
            <text fg={props.model.sessionResult.connection === "connected" && session.attach ? theme.running : theme.muted}>
              Bridge view: {props.model.sessionResult.connection === "connected" && session.attach ? displayText(session.attach.target) : "no verified tmux target"}
            </text>
            <text fg={theme.accent}>Recorded activity</text>
            <Show when={session.recentActivity.length} fallback={<text fg={theme.muted}>No runtime activity recorded.</text>}>
              <For each={session.recentActivity.slice(0, 5)}>{(activity) => <text fg={theme.regular}>• {displayText(activity, 160)}</text>}</For>
            </Show>
          </box>
        )}</For>
        <Show when={props.model.sessionResult.connection === "connected" && !sessions.some((session) => !!session.sessionId)}>
          <text fg={theme.muted}>No active runtime session occupies this seat.</text>
        </Show>
      </box>
    );
  };

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} padding={1} gap={1}>
      <box height={2} flexDirection="column">
        <text fg={theme.heading}>INDRA  /  {page() === "teams" ? "Teams" : displayText(team()?.displayName)}  /  {runtime()}</text>
        <text fg={props.model.stateError ? theme.error : theme.muted}>
          {stateSummary()}  ·  {displayText(props.model.sessionResult.message) || "Auto-updating"}
        </text>
      </box>

      <Show when={page() === "teams"}>
        <scrollbox flexGrow={1} scrollY>
          <Show when={props.model.teams.length} fallback={<text fg={theme.idle}>{props.model.stateError ? "No usable team state is available." : "No teams are recorded."}</text>}>
            <For each={props.model.teams}>{(item) => {
              const selected = () => { props.revision(); return props.model.teamId === item.id; };
              const occupied = () => { props.revision(); return props.model.sessionResult.connection === "connected"
                ? item.seats.filter((member) => props.model.sessionResult.sessions.some((session) => session.teamId === item.id && session.seatId === member.id && session.sessionId)).length.toString()
                : "unknown"; };
              return (
                <box height={3} flexDirection="column" paddingLeft={1} backgroundColor={selected() ? theme.selected : theme.panel}>
                  <text fg={selected() ? theme.accent : theme.regular}>{selected() ? "▶ " : "  "}{displayText(item.displayName)}  ({displayText(item.slug)})</text>
                  <text fg={theme.muted}>{item.seats.length} stable seats  ·  {occupied()} with runtime sessions</text>
                </box>
              );
            }}</For>
          </Show>
        </scrollbox>
      </Show>

      <Show when={page() === "team" && !!team()}>
        <box flexGrow={1} flexDirection={wide() ? "row" : "column"} gap={1}>
          <scrollbox flexGrow={1} width={wide() ? "62%" : "100%"} scrollY border borderColor="#42536B" title={(team()?.displayName ?? "Team") + " · " + (team()?.seats.length ?? 0) + " STABLE SEATS"} titleColor={theme.accent}>
            <Show when={team()?.seats.length} fallback={<text fg={theme.idle}>No seats are recorded for this team.</text>}>
              <For each={team()?.seats ?? []}>{(item) => {
                const status = () => { props.revision(); return occupancy(props.model, item); };
                const selected = () => { props.revision(); return props.model.seatId === item.id; };
                const activity = () => { props.revision(); return activityLine(props.model, item, wide() ? 100 : 60); };
                return (
                  <box height={wide() ? 3 : 2} flexDirection="column" paddingLeft={1} backgroundColor={selected() ? theme.selected : theme.panel}>
                    <text fg={selected() ? theme.accent : theme.regular}>
                      {selected() ? "▶ " : "  "}{displayText(item.displayName, wide() ? 80 : 22)}  ·  {displayText(item.roles.join(", ") || "No role", wide() ? 80 : 16)}{wide() ? "" : "  ·  " + status().label}
                    </text>
                    <Show when={wide()}><text fg={status().color}>  {status().label}</text></Show>
                    <text fg={theme.muted}>
                      {"  "}{activity()}
                    </text>
                  </box>
                );
              }}</For>
            </Show>
          </scrollbox>
          <Show when={wide()}><scrollbox width="38%" height="100%" scrollY>
            {seatDetail()}
            <For each={props.model.snapshot?.sprints.filter((sprint) => sprint.teamId === team()?.id) ?? []}>{(sprint) => (
              <box flexDirection="column" padding={1}>
                <text fg={theme.idle}>DRAFT SPRINT · {displayText(sprint.phase)}</text>
                <text fg={theme.muted}>{displayText(sprint.goal, 150)}</text>
              </box>
            )}</For>
          </scrollbox></Show>
        </box>
      </Show>

      <Show when={page() === "seat"}>
        <scrollbox flexGrow={1} scrollY>{seatDetail()}</scrollbox>
      </Show>

      <box height={notice() ? 3 : 2} flexDirection="column">
        <Show when={notice()}><text fg={theme.idle}>{displayText(notice())}</text></Show>
        <text fg={theme.accent}>
          {page() === "teams" ? "↑↓ choose team  ·  Enter open  ·  q quit" : page() === "team" ? "↑↓ choose seat  ·  Enter details  ·  b teams  ·  q quit" : "a attach bridge view  ·  b team  ·  q quit"}
        </text>
        <text fg={theme.muted}>Auto-update  ·  r checks now  ·  q leaves sessions running</text>
      </box>
    </box>
  );
}

/** Start the Solid/OpenTUI screen; renderer ownership and terminal cleanup stay in this function. */
export async function runTerminalUi(state: StateInventory, sessions: SessionReadPort, options: {
  pollMs?: number;
  attach?: (target: string) => Promise<void>;
  signal?: AbortSignal;
} = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The terminal UI needs an interactive TTY. Use --once for redirected output.");
  const model = new TerminalUiModel(state, sessions);
  await model.refresh();
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  const [revision, setRevision] = createSignal(model.revision);
  let active = true;
  let refreshing = false;
  let attaching = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const refresh = async () => {
    if (!active || refreshing || attaching) return;
    refreshing = true;
    try { if (await model.refresh() && active) setRevision(model.revision); }
    catch (error) {
      if (active) {
        model.notice = error instanceof Error ? error.message : "Refresh failed.";
        model.revision++;
        setRevision(model.revision);
      }
    }
    finally { refreshing = false; }
  };
  return await new Promise<number>((resolve, reject) => {
    const cleanup = (): boolean => {
      if (!active) return false;
      active = false;
      if (timer) clearInterval(timer);
      options.signal?.removeEventListener("abort", finish);
      renderer.destroy();
      return true;
    };
    const finish = () => { if (cleanup()) resolve(0); };
    const key = (name: string, ctrl?: boolean) => {
      if (!active || attaching) return;
      if (ctrl && name === "c") { finish(); return; }
      const action = model.key(name);
      setRevision(model.revision);
      if (action === "quit") finish();
      else if (action === "refresh") void refresh();
      else if (action === "attach") {
        const target = model.attachTarget();
        if (!target) return;
        attaching = true;
        renderer.suspend();
        void (options.attach ?? attachTmux)(target).catch((error: unknown) => {
          model.notice = error instanceof Error ? error.message : "Could not attach to tmux.";
        }).finally(() => {
          if (active) {
            renderer.resume();
            attaching = false;
            model.revision++;
            setRevision(model.revision);
            void refresh();
          }
        });
      }
    };
    render(() => <TerminalApp model={model} revision={revision} onKey={key} />, renderer)
      .then(() => {
        if (!active) return;
        timer = setInterval(() => { void refresh(); }, Math.max(500, options.pollMs ?? 2000));
        options.signal?.addEventListener("abort", finish, { once: true });
        if (options.signal?.aborted) finish();
      })
      .catch((error: unknown) => { cleanup(); reject(error); });
  });
}
