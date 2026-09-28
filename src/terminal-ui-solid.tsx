import { createCliRenderer } from "@opentui/core";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import type { StateInventory, StateSeat } from "./state-domain.js";
import { attachTmux } from "./tmux-attach.js";
import { currentSession, displayText, newestPlanningRecord, TerminalUiModel, type SessionReadPort, type StateSyncPort, type TerminalSession, type UiApproval, type UiRollback, type UiView, type UpdatePort } from "./terminal-ui.js";
import type { GoalStarter, SeatLive, SeatProcessPort } from "./supervisor.js";

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

const processColor: Record<SeatLive["process"], string> = { running: theme.running, stopped: theme.idle, "no credential": theme.error, "no channel": theme.error };
const isDeveloper = (seat: StateSeat) => seat.roles.includes("Developer");
const processLabel = (live: SeatLive) => live.process.toUpperCase() + (live.updatePending ? " · UPDATE PENDING" : "");

function assignmentLine(live: SeatLive, limit: number): string {
  const held = live.assignment;
  if (!held) return "No assignment";
  return displayText(held.title, limit) + " · " + displayText(held.status, 20) + (held.prUrl ? " · " + displayText(held.prUrl, 120) : "");
}

function threadActivity(live: SeatLive, limit: number): string {
  return live.activity ? "Latest: " + displayText(live.activity.message, limit) : "No thread activity yet.";
}

function confirmText(confirm: UiApproval | UiRollback, width: number): string {
  if (confirm.action === "rollback") return `Roll back from ${displayText(confirm.from, 20)} to ${displayText(confirm.to, 20)} and pause auto-update? y roll back`;
  return (confirm.action === "propose" ? "Request Chick's proposal for " : "Approve the proposal for ") + displayText(confirm.goalId, 40) + " (" + displayText(confirm.goal, Math.max(10, width - 80)) + ")? " + (confirm.action === "propose" ? "y request" : "y approve");
}

export interface TerminalAppProps {
  model: TerminalUiModel;
  revision: Accessor<number>;
  onKey: (name: string, ctrl?: boolean, text?: string) => void;
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
  const sync = createMemo(() => { props.revision(); return props.model.syncLine(); });
  const update = createMemo(() => { props.revision(); return props.model.updateLine(); });

  const input = createMemo(() => { props.revision(); return props.model.input ? { ...props.model.input } : undefined; });
  const confirm = createMemo(() => { props.revision(); return props.model.confirm ? { ...props.model.confirm } : undefined; });
  const paused = createMemo(() => { props.revision(); return props.model.paused; });

  useKeyboard((key) => props.onKey(key.name, key.ctrl, key.sequence));

  const seatDetail = () => {
    props.revision();
    const selected = seat();
    if (!selected) return <text fg={theme.muted}>Select a seat to inspect its runtime.</text>;
    const state = occupancy(props.model, selected);
    const sessions = props.model.sessionsFor(selected.id);
    const live = props.model.live[selected.id];
    return (
      <box flexDirection="column" gap={1} padding={1} backgroundColor={theme.panel} border borderColor="#42536B" title="SEAT DETAIL" titleColor={theme.accent}>
        <text fg={theme.heading}>{displayText(selected.displayName)}  @{displayText(selected.handle)}</text>
        <text fg={theme.regular}>Role: {displayText(selected.roles.join(", ") || "none")}</text>
        {live ? (
          <box flexDirection="column" gap={0}>
            <text fg={processColor[live.process]}>Process: {live.process}{live.updatePending ? " · update pending (restarts when idle)" : ""}{isDeveloper(selected) ? " (seat runner)" : " (planning bridge)"}  ·  s restart  ·  x stop</text>
            <Show when={live.problem}><text fg={theme.error}>{displayText(live.problem, 300)}</text></Show>
            <Show when={isDeveloper(selected)}>
              <text fg={theme.regular}>Assignment: {assignmentLine(live, 160)}</text>
              <text fg={theme.muted}>{threadActivity(live, 300)}{live.activity ? "  (" + displayText(live.activity.at) + ")" : ""}</text>
            </Show>
          </box>
        ) : null}
        <text fg={state.color}>{state.label}</text>
        <Show when={props.model.sessionResult.connection !== "connected"}>
          <text fg={theme.idle}>{displayText(props.model.sessionResult.message) || "Session reader unavailable."}</text>
        </Show>
        <For each={sessions}>{(session) => (
          <box flexDirection="column" gap={0}>
            <text fg={theme.accent}>Planning goal: {displayText(session.goal, 160)}</text>
            <text fg={theme.regular}>Stage: {displayText(session.stage)}  ·  {props.model.sessionResult.connection === "connected" ? "Codex session" : "Last Codex session"}: {displayText(session.sessionId) || "not started"}</text>
            <text fg={theme.muted}>Updated: {displayText(session.updatedAt) || "not reported"}</text>
            <Show when={session.stage === "clarifying"}>
              <text fg={theme.idle}>Clarifying · {session.id === props.model.clarifyingGoal()?.id ? "P requests Chick's proposal here" : "P requests the newer goal's proposal first"}, or react :memo: on the goal post</text>
            </Show>
            <Show when={session.stage === "awaiting-review"}>
              <text fg={theme.idle}>Proposal awaiting review · {session.id === props.model.reviewGoal()?.id ? "A approves it here" : "A approves the newer goal first"}, or react :white_check_mark: on its proposal post</text>
            </Show>
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
      <box height={2 + (sync() ? 1 : 0) + (update() ? 1 : 0)} flexDirection="column">
        <text fg={theme.heading}>INDRA  /  {page() === "teams" ? "Teams" : displayText(team()?.displayName)}  /  {runtime()}</text>
        <text fg={props.model.stateError ? theme.error : theme.muted}>
          {stateSummary()}  ·  {displayText(props.model.sessionResult.message) || "Auto-updating"}
        </text>
        <Show when={sync()}><text fg={sync()?.ok ? theme.muted : theme.error}>{displayText(sync()?.text, Math.max(20, dimensions().width - 4))}</text></Show>
        <Show when={update()}><text fg={update()?.ok ? theme.muted : theme.error}>{displayText(update()?.text, Math.max(20, dimensions().width - 4))}</text></Show>
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
                const live = () => { props.revision(); return props.model.live[item.id]; };
                // A Developer seat with live data shows its runner and assignment; otherwise the planning occupancy.
                const dev = () => { const value = live(); return value && isDeveloper(item) ? value : undefined; };
                const activity = () => { props.revision(); const value = dev(); return value ? threadActivity(value, wide() ? 100 : 60) : activityLine(props.model, item, wide() ? 100 : 60); };
                const headline = () => {
                  const value = live();
                  const suffix = wide() ? (value ? "  ·  " + processLabel(value) : "") : "  ·  " + (dev() ? processLabel(dev()!) : value?.problem ? processLabel(value) : status().label);
                  return (selected() ? "▶ " : "  ") + displayText(item.displayName, wide() ? 80 : 22) + "  ·  " + displayText(item.roles.join(", ") || "No role", wide() ? 80 : 16) + suffix;
                };
                // A process that could not start says why, e.g. which bot cannot join which channel; the seat detail shows it in full.
                const problem = () => { const value = live(); return value?.problem ? displayText(value.problem, 60) : undefined; };
                const second = () => { const value = dev(); const reason = problem(); if (reason) return { text: reason, color: theme.error }; return value ? { text: assignmentLine(value, wide() ? 60 : 40), color: processColor[value.process] } : { text: status().label, color: status().color }; };
                return (
                  <box height={wide() ? 3 : 2} flexDirection="column" paddingLeft={1} backgroundColor={selected() ? theme.selected : theme.panel}>
                    <text fg={selected() ? theme.accent : theme.regular}>{headline()}</text>
                    <Show when={wide()}><text fg={second().color}>  {second().text}</text></Show>
                    <text fg={!wide() && problem() ? theme.error : theme.muted}>
                      {"  "}{!wide() && problem() ? problem() : !wide() && dev()?.assignment ? assignmentLine(dev()!, 60) : activity()}
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

      <box height={(notice() ? 3 : 2) + (input() || confirm() ? 1 : 0)} flexDirection="column">
        <Show when={notice()}><text fg={theme.idle}>{displayText(notice())}</text></Show>
        <Show when={input()}>
          <text fg={theme.heading}>
            New planning goal: {(input()?.value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").slice(-Math.max(10, dimensions().width - 26))}▏
          </text>
        </Show>
        <Show when={confirm()}>
          <text fg={theme.heading}>{confirmText(confirm()!, dimensions().width)} · any other key cancels</text>
        </Show>
        <text fg={theme.accent}>
          {input() ? "Enter start  ·  Esc cancel  ·  " + displayText(team()?.project?.github, 80) + " · home channel" : page() === "teams" ? "↑↓ choose team  ·  Enter open  ·  n new goal  ·  q quit" : page() === "team" ? "↑↓ seat · Enter details · n new goal · s restart · x stop · b teams · q quit" : "a attach  ·  P propose  ·  A approve  ·  s restart  ·  x stop  ·  n new goal  ·  b team  ·  q quit"}
        </text>
        <text fg={theme.muted}>{paused() ? "Auto-update paused  ·  U resumes" : "Auto-update  ·  U pauses"}  ·  r checks now  ·  R rolls back  ·  q leaves seat processes running</text>
      </box>
    </box>
  );
}

/** Start the Solid/OpenTUI screen; renderer ownership and terminal cleanup stay in this function. */
export async function runTerminalUi(state: StateInventory, sessions: SessionReadPort, options: {
  pollMs?: number;
  attach?: (target: string) => Promise<void>;
  signal?: AbortSignal;
  /** Hosts and controls the bridge and seat runners; they keep running after the UI quits. */
  processes?: SeatProcessPort;
  goals?: GoalStarter;
  /** Syncs the state checkout with its remote before hosting processes, then every `syncMs`. */
  sync?: StateSyncPort;
  syncMs?: number;
  /** Pulls and builds new Indra code every `updateMs`; the UI reloads when `dist/` holds a newer build. */
  update?: UpdatePort;
  updateMs?: number;
  /** The view to open on, saved by the previous UI before a reload. */
  view?: UiView;
  /** Saves the view and returns the exit code that asks the launcher to start the UI again. */
  reload?: (view: UiView) => Promise<number>;
} = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The terminal UI needs an interactive TTY. Use --once for redirected output.");
  const model = new TerminalUiModel(state, sessions, options.processes, options.goals, options.sync, options.update);
  if (options.view) model.restore(options.view);
  await model.refresh();
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
  const [revision, setRevision] = createSignal(model.revision);
  model.changed = () => { if (active) setRevision(model.revision); };
  let active = true;
  let refreshing = false;
  let attaching = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let updateTimer: ReturnType<typeof setInterval> | undefined;
  let reloadNow = () => {};
  const refresh = async () => {
    if (!active || refreshing || attaching) return;
    refreshing = true;
    try {
      if (await model.refresh() && active) setRevision(model.revision);
      // A new build (self-update or `npm run dev`) reloads the UI once nothing is in flight.
      if (await model.checkBuild() && model.readyToReload() && active && !attaching) reloadNow();
    }
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
      if (syncTimer) clearInterval(syncTimer);
      if (updateTimer) clearInterval(updateTimer);
      options.signal?.removeEventListener("abort", finish);
      renderer.destroy();
      return true;
    };
    const finish = () => { if (cleanup()) resolve(0); };
    reloadNow = () => {
      const view = model.view();
      if (options.reload && cleanup()) options.reload(view).then(resolve, reject);
    };
    const key = (name: string, ctrl?: boolean, text?: string) => {
      if (!active || attaching) return;
      if (ctrl && name === "c") { finish(); return; }
      const action = model.key(name, text);
      setRevision(model.revision);
      if (action === "quit") finish();
      else if (action === "refresh") { void refresh(); void model.updateCode(); }
      else if (action === "pause") void model.togglePause();
      else if (action === "ask-rollback") void model.askRollback();
      else if (action === "rollback") void model.rollbackConfirmed();
      else if (action === "submit") void model.submitInput();
      else if (action === "approve") void model.approveConfirmed();
      else if (action === "propose") void model.proposeConfirmed();
      else if (action === "stop" || action === "restart") void model.control(action);
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
        void model.start();
        if (options.sync) syncTimer = setInterval(() => { if (active && !attaching) void model.syncState(); }, Math.max(5_000, options.syncMs ?? 60_000));
        if (options.update) updateTimer = setInterval(() => { if (active && !attaching) void model.updateCode(); }, Math.max(5_000, options.updateMs ?? 60_000));
        options.signal?.addEventListener("abort", finish, { once: true });
        if (options.signal?.aborted) finish();
      })
      .catch((error: unknown) => { cleanup(); reject(error); });
  });
}
