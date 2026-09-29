import { execFile } from "node:child_process";
import { createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import { render, useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import { createFrameClock, HeaderBar, IdleSplash } from "./hub-canvas.js";
import { supportsTruecolor, TokenBurn } from "./hub-paint.js";
import type { StateInventory } from "./state-domain.js";
import { attachTmux } from "./tmux-attach.js";
import { displayText, GOAL_INPUT_LIMIT, sessionSprint, TerminalUiModel, type SessionReadPort, type StateSyncPort, type UiApproval, type UiRetry, type UiRollback, type UiView, type UpdatePort } from "./terminal-ui.js";
import { engineLabel } from "./session-snapshot.js";
import type { GoalStarter, SeatProcessPort } from "./supervisor.js";
import type { PaneTailSource } from "./pane-tail.js";
import { PaneTailPanel } from "./pane-tail-panel.js";
import { keyInput } from "./key-batch.js";
import { HelpOverlay } from "./help-overlay.js";
import { TranscriptView } from "./transcript-view.js";
import type { TranscriptSource } from "./session-transcript.js";
import { RETURN_KEY, WATCH_HINT, WATCH_HINT_MS } from "./watch-keys.js";
import { isFinishedSprint } from "./finished-sprint.js";
import { CI_DOT, formatTokens, openableUrl, pipelineSteps, prLabel, sumUsage, totalTokens, usageLine } from "./hub-format.js";
import {
  assignmentLine, createTicker, elapsedText, harnessText, HUB_STATE, isDeveloper, LinkText, occupancy, PipelineLabels, processColor, SeatRow,
  seatState, SprintCard, SprintStrip, stateColor, theme, threadActivity, type HubState,
} from "./hub-view.js";

/** The end of a long goal, as many characters as fit in six wrapped lines, so the cursor stays visible. */
function goalInputTail(value: string, width: number): string {
  const visible = Math.max(10, width - 2) * 6 - 20;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return clean.length > visible ? "…" + clean.slice(-(visible - 1)) : clean;
}

function confirmText(confirm: UiApproval | UiRollback | UiRetry, width: number): string {
  if (confirm.action === "rollback") return `Roll back from ${displayText(confirm.from, 20)} to ${displayText(confirm.to, 20)} and pause auto-update? y roll back`;
  if (confirm.action === "retry") {
    const goal = "Retry goal " + displayText(confirm.goalId, 40) + ": ";
    const outcome = "Outcome " + displayText(confirm.outcomeId, 40) + ": ";
    return goal + displayText(confirm.goal, Math.max(10, width - goal.length - 4)) + "\n"
      + outcome + displayText(confirm.title, Math.max(10, width - outcome.length - 5)) + "?\n"
      + "y re-queue for " + displayText(confirm.seatId, 40);
  }
  const [question, yes] = {
    propose: ["Request Chick's proposal for ", "y request"],
    approve: ["Approve the proposal for ", "y approve"],
    integrate: ["Open the integration PR into main, for what merged, for sprint ", "y open"],
    merge: [confirm.mergeKind === "revert" ? "Merge the revert PR on main for sprint " : confirm.mergeKind === "retro" ? "Merge the retro publication PR into main for sprint " : "Merge the release integration PR into main for sprint ", "y merge"],
    revert: ["Roll back sprint ", "y open a revert PR"],
  }[confirm.action];
  return question + displayText(confirm.goalId, 40) + " (" + displayText(confirm.goal, Math.max(10, width - 80)) + ")? " + yes
    + (confirm.prUrl ? "\nPR: " + displayText(confirm.prUrl, 2000) : "");
}

/** Pane lines on the seat screen: what is left of a 42-row screen after the seat card, sprint strip and footer. */
export function seatPaneLines(height: number): number {
  return Math.max(6, Math.min(15, height - 28));
}

export interface TerminalAppProps {
  model: TerminalUiModel;
  revision: Accessor<number>;
  onKey: (name: string, ctrl?: boolean, text?: string) => void;
  /** Reads the selected seat's live pane while its detail is visible. */
  paneTail?: PaneTailSource;
  /** Reads the selected seat's engine session log while the transcript (`t`) is open. */
  transcript?: TranscriptSource;
  /** Opens a clicked link (a PR or a Mattermost post); without it links are still OSC 8 hyperlinks. */
  openUrl?: (url: string) => void;
  /** The blink phase and the clock; tests pass their own, the app runs one shared ticker. */
  pulse?: Accessor<boolean>;
  now?: Accessor<number>;
  /** The animation frame for the header drift and the splash shimmer; the app runs its own clock only while they move. */
  frame?: Accessor<number>;
  /** Forces truecolor on or off; by default it is detected, and without it colours snap to the 256-colour palette. */
  truecolor?: boolean;
}

export function TerminalApp(props: TerminalAppProps) {
  const dimensions = useTerminalDimensions();
  const ticker = props.pulse && props.now ? undefined : createTicker();
  const pulse = props.pulse ?? ticker!.pulse;
  const now = props.now ?? ticker!.now;
  const open = (url: string) => props.openUrl?.(url);
  const page = createMemo(() => { props.revision(); return props.model.page; });
  const team = createMemo(() => { props.revision(); return props.model.team; });
  const seat = createMemo(() => { props.revision(); return props.model.seat; });
  const runtime = createMemo(() => {
    props.revision();
    const connection = props.model.sessionResult.connection;
    return connection === "connected" ? { text: "🟢 RUNTIME CONNECTED", color: theme.running } : connection === "error" ? { text: "🔴 RUNTIME ERROR", color: theme.error } : { text: "🟡 RUNTIME DISCONNECTED", color: theme.idle };
  });
  const stateSummary = createMemo(() => {
    props.revision();
    return props.model.stateError
      ? "STATE ERROR · " + displayText(props.model.stateError)
      : "State loaded " + (displayText(props.model.refreshedAt) || "pending");
  });
  const notice = createMemo(() => { props.revision(); return props.model.notice; });
  const launchWarning = createMemo(() => { props.revision(); return props.model.launchWarning; });
  const sync = createMemo(() => { props.revision(); return props.model.syncLine(); });
  const update = createMemo(() => { props.revision(); return props.model.updateLine(); });

  const input = createMemo(() => { props.revision(); return props.model.input ? { ...props.model.input } : undefined; });
  const confirm = createMemo(() => { props.revision(); return props.model.confirm ? { ...props.model.confirm } : undefined; });
  const paused = createMemo(() => { props.revision(); return props.model.paused; });
  const sprints = createMemo(() => { props.revision(); return props.model.sprintsForTeam(); });
  const sessionOf = (id: string) => props.model.sessionResult.sessions.find((session) => session.id === id);
  const newGoalBlocked = createMemo(() => { props.revision(); return props.model.newGoalBlocked(); });
  const newGoalHint = createMemo(() => {
    props.revision();
    const open = props.model.openGoals();
    return newGoalBlocked() && open.length ? "New goal blocked: " + open.map((goal) => goal.id).join(", ") + " still open." : newGoalBlocked();
  });
  const ceremonyKeys = createMemo(() => { props.revision(); return props.model.ceremonyKeys(); });
  // Per-cell polish (hub-canvas.tsx): the header drifts while any sprint runs, and the splash shows on an idle team.
  const sprintRunning = createMemo(() => { props.revision(); return props.model.sessionResult.sessions.some((session) => !isFinishedSprint(sessionSprint(session).loop)); });
  const splash = createMemo(() => page() === "team" && !!team() && sprints().length === 0);
  const frame = props.frame ?? createFrameClock(() => sprintRunning() || splash());
  const renderer = useRenderer();
  const [detected, setDetected] = createSignal(supportsTruecolor(renderer.capabilities));
  const onCapabilities = () => setDetected(supportsTruecolor(renderer.capabilities));
  renderer.on("capabilities", onCapabilities);
  onCleanup(() => renderer.off("capabilities", onCapabilities));
  const truecolor = () => props.truecolor ?? detected();
  const burn = new TokenBurn();
  const overlay = createMemo(() => { props.revision(); return props.model.overlay; });
  /** Seats per state for the team title: the owner sees at once how many run, wait, need them or failed. */
  const teamCounts = createMemo(() => {
    props.revision();
    const counts = new Map<HubState, number>();
    for (const item of team()?.seats ?? []) { const state = seatState(props.model, item); counts.set(state, (counts.get(state) ?? 0) + 1); }
    return (["running", "waiting", "needs", "failed", "idle"] as HubState[]).filter((state) => counts.get(state)).map((state) => HUB_STATE[state].icon + " " + counts.get(state) + " " + HUB_STATE[state].word).join(" · ");
  });

  let teamScroll: ScrollBoxRenderable | undefined;
  let detailScroll: ScrollBoxRenderable | undefined;
  useKeyboard((key) => {
    if (!props.model.input && !props.model.confirm && !props.model.overlay && (key.name === "pageup" || key.name === "pagedown")) {
      const target = page() === "seat" ? detailScroll : page() === "team" ? teamScroll : undefined;
      target?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
    } else props.onKey(key.name, key.ctrl, key.sequence);
  });
  // A bracketed paste arrives as one event; only the goal input takes text, so a paste elsewhere is ignored.
  usePaste((event) => { if (props.model.input) props.onKey("paste", false, new TextDecoder().decode(event.bytes)); });

  const seatDetail = () => {
    props.revision();
    const selected = seat();
    if (!selected) return <text fg={theme.muted}>Select a seat to inspect its runtime.</text>;
    const state = occupancy(props.model, selected);
    const hub = seatState(props.model, selected);
    const connected = props.model.sessionResult.connection === "connected";
    // The open goals (a team holds at most one), or else the newest finished one: planning history stays off this screen.
    const records = [...props.model.sessionsFor(selected.id)].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const openRecords = records.filter((session) => !isFinishedSprint(sessionSprint(session).loop));
    const sessions = (openRecords.length ? openRecords : records).slice(0, 2);
    const live = props.model.live[selected.id];
    const held = live?.assignment;
    const facts = held?.facts;
    const leadUsage = sumUsage(sessions.map((session) => session.usage));
    return (
      <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} backgroundColor={theme.panel} border borderColor={theme.border} title=" 🪑 SEAT DETAIL " titleColor={theme.accent}>
        <text>
          <span style={{ fg: theme.heading }}>{displayText(selected.displayName)}  @{displayText(selected.handle)}</span>
          <span style={{ fg: theme.muted }}>{" · Role: " + displayText(selected.roles.join(", ") || "none") + " · "}</span>
          <span style={{ fg: stateColor(hub, pulse()) }}>{HUB_STATE[hub].icon + " " + HUB_STATE[hub].word.toUpperCase()}</span>
        </text>
        <Show when={live}>
          <text fg={processColor[live!.process]}>Process: {live!.process}{live!.updatePending ? " · update pending (restarts when idle)" : ""}{isDeveloper(selected) ? " (seat runner)" : " (planning bridge)"}  ·  s restart  ·  x stop</text>
          <Show when={live!.problem}><text fg={stateColor("failed", pulse())} wrapMode="word">⚠ {displayText(live!.problem, 300)}</text></Show>
        </Show>
        <text fg={theme.heading}>🤖 {live?.harness ? `${live.harness.engine === "claude" ? "Claude" : "Codex"} · model ${displayText(live.harness.model, 40)} · effort ${displayText(live.harness.effort, 20)}` : harnessText(undefined)}</text>
        <Show when={!isDeveloper(selected)}><text fg={theme.accent}>🧮 Planning: {usageLine(leadUsage)}</text></Show>
        <Show when={live && isDeveloper(selected)}>
          <text fg={theme.regular} wrapMode="word">Assignment: {assignmentLine(live!, 160)}</text>
          <Show when={held}>
            <box flexDirection="row" height={1} flexShrink={0}>
              <text flexShrink={0}>{"   "}</text>
              <LinkText url={held?.prUrl} label={held?.prUrl ? "🐙 " + (prLabel(held?.prUrl, true) ?? "PR") : "PR not opened"} open={open} />
              <text flexShrink={0} fg={theme.muted}>{(facts?.ci ? " · " + CI_DOT[facts.ci] + " CI " + facts.ci : "") + " · " + (facts?.sessions ?? 0) + " sessions · ⌛ " + elapsedText(facts ?? {}, now()) + " on this task"}</text>
            </box>
            <PipelineLabels steps={pipelineSteps({ status: held!.status, step: facts?.step, fixRounds: facts?.fixRounds })} pulse={pulse} />
            <text fg={theme.accent}>🧮 {usageLine(facts?.usage)}</text>
          </Show>
          <Show when={live!.retry}><text fg={stateColor("needs", pulse())}>🙋 T retries {displayText(live!.retry?.goalId, 40)}/{displayText(live!.retry?.outcomeId, 40)}: {displayText(live!.retry?.title, 120)} (confirm first)</text></Show>
          <text fg={theme.muted}>💬 {threadActivity(live!, 300)}{live!.activity ? "  (" + displayText(live!.activity.at) + ")" : ""}</text>
        </Show>
        <text fg={state.color}>{state.label}</text>
        <Show when={!connected}>
          <text fg={theme.idle}>{displayText(props.model.sessionResult.message) || "Session reader unavailable."}</text>
        </Show>
        <For each={sessions}>{(session) => (
          <box flexDirection="column" flexShrink={0}>
            <text fg={theme.accent} wrapMode="word">Planning goal: {displayText(session.goal, 160)}</text>
            <text fg={theme.regular} wrapMode="word">Planning detail: {displayText(session.stage)}  ·  {connected ? "" : "Last "}{engineLabel(session.engine)} session: {displayText(session.sessionId) || "not started"}  ·  {session.runs ?? 0} runs · 🧮 Σ{formatTokens(totalTokens(session.usage))}  ·  updated {displayText(session.updatedAt) || "not reported"}</text>
            <Show when={session.id === props.model.clarifyingGoal()?.id}>
              <text fg={stateColor("needs", pulse())}>🙋 P requests Chick's proposal here, or react :memo: on the goal post</text>
            </Show>
            <Show when={session.id === props.model.reviewGoal()?.id}>
              <text fg={stateColor("needs", pulse())}>🙋 A approves it here, or react :white_check_mark: on its proposal post</text>
            </Show>
            <text fg={connected && session.attach ? theme.running : theme.muted}>
              Live view: {connected && session.attach ? "a watch · " + RETURN_KEY + " back" : "not available"}
            </text>
            <Show when={session.recentActivity.length} fallback={<text fg={theme.muted}>No runtime activity recorded.</text>}>
              <For each={session.recentActivity.slice(0, 3)}>{(activity) => <text fg={theme.regular}>• {displayText(activity, 160)}</text>}</For>
            </Show>
          </box>
        )}</For>
        <Show when={connected && !sessions.some((session) => !!session.sessionId)}>
          <text fg={theme.muted}>No active runtime session occupies this seat.</text>
        </Show>
      </box>
    );
  };

  const keyLine = () => input() ? (newGoalBlocked() ? "Start blocked · Esc cancel" : "Enter start · Esc cancel") + " · " + displayText(team()?.project?.github, 80) + " · home channel"
    : [page() === "teams" ? "↑↓ choose team · Enter open" : page() === "team" ? "↑↓ seat · Enter details · T retry · s restart · x stop · b teams" : `a watch (${RETURN_KEY} back) · t transcript · T retry · s restart · x stop · b team`,
      ...ceremonyKeys(), ...(newGoalBlocked() ? [] : ["n new goal"]), "q quit"].join(" · ");

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} paddingLeft={1} paddingRight={1}>
      <box flexShrink={0} flexDirection="column">
        <HeaderBar frame={frame} drifting={sprintRunning} truecolor={truecolor()}>
          <text fg={theme.barText} flexGrow={1}>{" 💠 INDRA  ›  " + (page() === "teams" ? "Teams" : displayText(team()?.displayName, 30)) + (page() === "seat" && seat() ? "  ›  " + displayText(seat()?.displayName, 30) : "")}</text>
          <text fg={runtime().color} flexShrink={0}>{runtime().text + " "}</text>
        </HeaderBar>
        <text fg={props.model.stateError ? theme.error : theme.muted}>
          {displayText(stateSummary() + "  ·  " + (displayText(props.model.sessionResult.message) || "Auto-updating"), Math.max(20, dimensions().width - 3))}
        </text>
        <Show when={sync()}><text fg={sync()?.ok ? theme.muted : theme.error}>{displayText(sync()?.text, Math.max(20, dimensions().width - 3))}</text></Show>
        <Show when={update()}><text fg={update()?.ok ? theme.muted : theme.error}>{displayText(update()?.text, Math.max(20, dimensions().width - 3))}</text></Show>
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
                <box height={2} flexShrink={0} flexDirection="column" paddingLeft={1} backgroundColor={selected() ? theme.selected : theme.panel}>
                  <text fg={selected() ? theme.accent : theme.regular}>{selected() ? "▶ " : "  "}👥 {displayText(item.displayName)}  ({displayText(item.slug)})</text>
                  <text fg={theme.muted}>{"     "}{item.seats.length} stable seats  ·  {occupied()} with runtime sessions{item.project ? "  ·  🐙 " + displayText(item.project.github, 60) : ""}</text>
                </box>
              );
            }}</For>
          </Show>
        </scrollbox>
      </Show>

      <Show when={page() === "team" && !!team()}>
        <scrollbox id="team-scroll" ref={teamScroll} flexGrow={1} scrollY>
          <box flexDirection="column" flexShrink={0} border borderColor={theme.border} title={" 👥 " + displayText(team()?.displayName ?? "Team", 30) + " · " + (team()?.seats.length ?? 0) + " STABLE SEATS " + (teamCounts() ? "· " + teamCounts() + " " : "")} titleColor={theme.accent}>
            <Show when={team()?.seats.length} fallback={<text fg={theme.idle}>No seats are recorded for this team.</text>}>
              <For each={team()?.seats ?? []}>{(item) => <SeatRow model={props.model} seat={item} revision={props.revision} pulse={pulse} now={now} width={() => dimensions().width - 5} open={open} burn={burn} truecolor={truecolor()} />}</For>
            </Show>
          </box>
          <For each={sprints()}>{(sprint) => <SprintCard model={props.model} sprint={sprint} team={team()} session={sessionOf(sprint.id)} pulse={pulse} now={now} open={open} truecolor={truecolor()} />}</For>
          <Show when={splash()}>
            <IdleSplash frame={frame} truecolor={truecolor()} background={theme.background} caption="No sprint open" captionColor={theme.muted} />
          </Show>
        </scrollbox>
      </Show>

      <Show when={page() === "seat"}>
        <scrollbox id="detail-scroll" ref={detailScroll} flexGrow={1} scrollY>
          <Show when={props.paneTail && seat()}>
            <PaneTailPanel source={props.paneTail!} seat={seat} width={() => dimensions().width - 6} lines={() => seatPaneLines(dimensions().height)} />
          </Show>
          {seatDetail()}
          <For each={sprints()}>{(sprint) => <SprintStrip sprint={sprint} team={team()} session={sessionOf(sprint.id)} pulse={pulse} open={open} />}</For>
        </scrollbox>
      </Show>

      <box flexShrink={0} flexDirection="column">
        <Show when={newGoalHint()}><text fg={theme.idle} wrapMode="word">{displayText(newGoalHint(), 240)}</text></Show>
        <Show when={launchWarning()}><text fg={stateColor("failed", pulse())} wrapMode="word">⚠ {displayText(launchWarning())}</text></Show>
        <Show when={notice()}><text fg={theme.idle} wrapMode="word">{displayText(notice())}</text></Show>
        <Show when={input()}>
          <text fg={theme.heading} wrapMode="char">
            New planning goal: {goalInputTail(input()?.value ?? "", dimensions().width)}▏
          </text>
          <text fg={theme.muted}>
            {(input()?.value.length ?? 0) >= GOAL_INPUT_LIMIT ? `Limit reached (${GOAL_INPUT_LIMIT} characters); extra characters are ignored.` : `${input()?.value.length ?? 0}/${GOAL_INPUT_LIMIT}`}
          </text>
        </Show>
        <Show when={confirm()}>
          <text fg={stateColor("needs", pulse())} wrapMode="word">{confirmText(confirm()!, dimensions().width)}{confirm()?.action === "retry" ? " · n/Esc cancel" : " · any other key cancels"}</text>
        </Show>
        <text fg={theme.accent} wrapMode="word">{keyLine()}</text>
        <text fg={theme.muted}>? help  ·  {paused() ? "Auto-update paused  ·  U resumes" : "Auto-update  ·  U pauses"}  ·  r checks now  ·  R rolls back  ·  q quits, seats keep running</text>
      </box>
      <Show when={overlay() === "help"}><HelpOverlay /></Show>
      <Show when={overlay() === "transcript" && seat()}>
        <TranscriptView source={props.transcript} seat={seat()!} recordedHandle={() => props.model.selectedSession()?.sessionId} />
      </Show>
    </box>
  );
}

/**
 * Opens a link Indra built (a GitHub PR or a Mattermost page on Indra's server) with the system opener, without a
 * shell; anything else is refused. Returns the URL it opened.
 */
export function openLink(url: string, run: (file: string, args: string[]) => void = (file, args) => { execFile(file, args, () => {}); }, platform = process.platform): string | undefined {
  const safe = openableUrl(url);
  if (!safe) return undefined;
  run(platform === "darwin" ? "open" : "xdg-open", [safe]);
  return safe;
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
  /** Reads the selected seat's live pane while its detail is visible. */
  paneTail?: PaneTailSource;
  /** Returns a warning when Indra was launched under ttyd or its seats' tmux server cannot be verified. */
  launchCheck?: () => Promise<string | undefined>;
  /** Reads the selected seat's engine session log for the transcript view (`t`). */
  transcript?: TranscriptSource;
} = {}): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The terminal UI needs an interactive TTY. Use --once for redirected output.");
  const model = new TerminalUiModel(state, sessions, options.processes, options.goals, options.sync, options.update);
  model.launchCheck = options.launchCheck;
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
  const openUrl = (url: string) => {
    if (!active || attaching) return;
    const opened = openLink(url);
    model.notice = opened ? "Opened " + opened : "Not opened: that link is not a GitHub PR or an Indra Mattermost page.";
    model.revision++;
    setRevision(model.revision);
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
    // One screen rebuild per stdin chunk, not per key: a burst of keys otherwise exhausts OpenTUI's native renderables.
    const applyKey = keyInput(model, (current) => { if (active) setRevision(current); });
    const key = (name: string, ctrl?: boolean, text?: string) => {
      if (!active || attaching) return;
      if (ctrl && name === "c") { finish(); return; }
      const action = applyKey(name, text);
      if (action === "quit") finish();
      else if (action === "refresh") { void refresh(); void model.updateCode(); }
      else if (action === "pause") void model.togglePause();
      else if (action === "ask-rollback") void model.askRollback();
      else if (action === "rollback") void model.rollbackConfirmed();
      else if (action === "submit") void model.submitInput();
      else if (action === "approve") void model.approveConfirmed();
      else if (action === "propose") void model.proposeConfirmed();
      else if (action === "sprint") void model.sprintConfirmed();
      else if (action === "retry") void model.retryConfirmed();
      else if (action === "stop" || action === "restart") void model.control(action);
      else if (action === "attach") {
        const target = model.attachTarget();
        if (!target) return;
        attaching = true;
        // Say how to get back before the screen switches to the seat.
        model.notice = "Watching " + (model.seat?.displayName ?? "the seat") + " · " + WATCH_HINT;
        model.revision++;
        setRevision(model.revision);
        let suspended = false;
        void new Promise((wait) => setTimeout(wait, WATCH_HINT_MS)).then(() => {
          if (!active) return;
          suspended = true;
          renderer.suspend();
          return (options.attach ?? attachTmux)(target);
        }).then(() => { if (model.notice?.startsWith("Watching ")) model.notice = undefined; }, (error: unknown) => {
          model.notice = error instanceof Error ? error.message : "Could not open this seat's live view.";
        }).finally(() => {
          if (active) {
            if (suspended) renderer.resume();
            attaching = false;
            model.revision++;
            setRevision(model.revision);
            void refresh();
          }
        });
      }
    };
    render(() => <TerminalApp model={model} revision={revision} onKey={key} paneTail={options.paneTail} transcript={options.transcript} openUrl={openUrl} />, renderer)
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
