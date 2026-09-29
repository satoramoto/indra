import { execFile } from "node:child_process";
import { createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import { render, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
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
import { driveFallback, driveWarning, RETURN_KEY, WATCH_HINT, WATCH_HINT_MS } from "./watch-keys.js";
import type { AttachMode } from "./tmux-attach-owned.js";
import type { LiveUsagePort } from "./live-usage.js";
import { isFinishedSprint } from "./finished-sprint.js";
import { formatTokens, openableUrl, pipelineSteps, sumUsage, workTokens } from "./hub-format.js";
import { GLYPH } from "./hub-style.js";
import {
  ActivitySection, assignmentLine, AttentionSection, CI_COLOR, clip, createTicker, elapsedText, Field, FieldText, HUB_STATE, isDeveloper, KeyLegend, LinkText, occupancy, pad,
  PipelineLabels, prText, processColor, SeatHeader, SeatRow, Section, seatState, SprintCard, SprintStrip, stateColor, stateCounts, theme, threadActivity, UsageSpans,
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
    return connection === "connected" ? { text: "runtime connected", color: theme.ok } : connection === "error" ? { text: "runtime error", color: theme.bad } : { text: "runtime disconnected", color: theme.wait };
  });
  const stateSummary = createMemo(() => {
    props.revision();
    return props.model.stateError
      ? "State error · " + displayText(props.model.stateError)
      : "State loaded " + (displayText(props.model.refreshedAt) || "pending");
  });
  const notice = createMemo(() => { props.revision(); return props.model.notice; });
  const launchWarning = createMemo(() => { props.revision(); return props.model.launchWarning; });
  const sync = createMemo(() => { props.revision(); return props.model.syncLine(); });
  const update = createMemo(() => { props.revision(); return props.model.updateLine(); });
  /** The status line: state, sync and update in one dim row while all is well; a failing one gets its own red row. */
  const statusRows = createMemo(() => {
    const width = Math.max(20, dimensions().width - 2);
    const first = stateSummary() + "  " + GLYPH.separator + "  " + (displayText(props.model.sessionResult.message) || "Auto-updating");
    const parts = [sync(), update()].filter((part): part is { text: string; ok: boolean } => !!part);
    const quiet = [first, ...parts.filter((part) => part.ok).map((part) => part.text)].join("  " + GLYPH.separator + "  ");
    return [{ text: clip(displayText(quiet, 2000), width), ok: !props.model.stateError }, ...parts.filter((part) => !part.ok).map((part) => ({ text: displayText(part.text, width), ok: false }))];
  });

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
  const overlay = createMemo(() => { props.revision(); return props.model.overlay; });
  /** Seats per state for the seats title: the owner sees at once how many run, wait, need them or failed. */
  const teamCounts = createMemo(() => { props.revision(); return stateCounts(props.model, team()?.seats ?? []); });
  /** Content width inside the page's side padding. */
  const contentWidth = () => Math.max(20, dimensions().width - 3);
  /** One column on the right stays free for the scroll bar, so it never covers a row's last character. */
  const scrollContent = { paddingRight: 1 };

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
    if (!selected) return <text fg={theme.dim}>Select a seat to inspect its runtime.</text>;
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
    const leadUsage = props.model.withLiveUsage(selected.id, sumUsage(sessions.map((session) => session.usage)), sessions.map((session) => session.sessionId));
    const running = props.model.liveUsage[selected.id];
    const usage = isDeveloper(selected) ? props.model.withLiveUsage(selected.id, facts?.usage, facts?.sessionIds ?? []) : leadUsage;
    const sep = "  " + GLYPH.separator + "  ";
    return (
      <Section title={"SEAT " + displayText(selected.displayName, 40)}>
        <text flexShrink={0}>
          <span style={{ fg: stateColor(hub, pulse()) }}>{"  " + HUB_STATE[hub].glyph + " "}</span>
          <span style={{ fg: theme.text }}>{displayText(selected.displayName) + "  @" + displayText(selected.handle)}</span>
          <span style={{ fg: theme.dim }}>{sep + displayText(selected.roles.join(", ") || "no role") + sep}</span>
          <span style={{ fg: stateColor(hub, pulse()) }}>{HUB_STATE[hub].word}</span>
        </text>
        <Show when={live}>
          <FieldText label="process" value={live!.process + (live!.updatePending ? " · update pending (restarts when idle)" : "") + (isDeveloper(selected) ? " (seat runner)" : " (planning bridge)") + sep + "s restart" + sep + "x stop"}
            glyph={live!.process === "running" ? undefined : GLYPH.state.failed} glyphColor={processColor[live!.process]} />
          <Show when={live!.problem}><FieldText label="problem" value={displayText(live!.problem, 300)} glyph={GLYPH.warn} glyphColor={stateColor("failed", pulse())} /></Show>
        </Show>
        <FieldText label="harness" value={live?.harness ? `${live.harness.engine === "claude" ? "Claude" : "Codex"} · model ${displayText(live.harness.model, 40)} · effort ${displayText(live.harness.effort, 20)}` : "unknown"} />
        <Field label="tokens">
          <text flexShrink={1} flexGrow={1}>
            <UsageSpans usage={usage} context={running?.context} compactedAt={running?.compactedAt} now={now} />
            <span style={{ fg: theme.dim }}>{running ? sep + "includes the run in progress" : ""}</span>
          </text>
        </Field>
        <Show when={live && isDeveloper(selected)}>
          <FieldText label="assignment" value={assignmentLine(live!, 160)} />
          <Show when={held}>
            <Field label="pr">
              <LinkText url={held?.prUrl} label={held?.prUrl ? prText(held?.prUrl, true) : "not opened"} open={open} />
              <text flexShrink={0}>
                <span style={{ fg: theme.dim }}>{facts?.ci ? sep : ""}</span>
                <span style={{ fg: facts?.ci ? CI_COLOR[facts.ci] : theme.dim }}>{facts?.ci ? GLYPH.ci + " " : ""}</span>
                <span style={{ fg: theme.dim }}>{(facts?.ci ? "CI " + facts.ci : "") + sep + (facts?.sessions ?? 0) + " sessions" + sep + elapsedText(facts ?? {}, now()) + " on this task"}</span>
              </text>
            </Field>
            <Field label="steps"><PipelineLabels steps={pipelineSteps({ status: held!.status, step: facts?.step, fixRounds: facts?.fixRounds })} pulse={pulse} /></Field>
          </Show>
          <Show when={live!.retry}>
            <FieldText label="retry" value={`T retries ${displayText(live!.retry?.goalId, 40)}/${displayText(live!.retry?.outcomeId, 40)}: ${displayText(live!.retry?.title, 120)} (confirm first)`}
              glyph={GLYPH.state.needs} glyphColor={stateColor("needs", pulse())} />
          </Show>
          <FieldText label="latest" value={threadActivity(live!, 300) + (live!.activity ? "  (" + displayText(live!.activity.at) + ")" : "")} />
        </Show>
        <FieldText label="session" value={state.label} color={state.color} />
        <Show when={!connected}>
          <FieldText label="reader" value={displayText(props.model.sessionResult.message) || "Session reader unavailable."} color={theme.wait} />
        </Show>
        <For each={sessions}>{(session) => (
          <box flexDirection="column" flexShrink={0}>
            <FieldText label="goal" value={displayText(session.goal, 160)} />
            <FieldText label="detail" value={displayText(session.stage) + sep + (connected ? "" : "Last ") + engineLabel(session.engine) + " session: " + (displayText(session.sessionId) || "not started")
              + sep + (session.runs ?? 0) + " runs" + sep + "work " + formatTokens(workTokens(session.usage)) + sep + "updated " + (displayText(session.updatedAt) || "not reported")} />
            <Show when={session.id === props.model.clarifyingGoal()?.id}>
              <FieldText label="proposal" value="P requests Chick's proposal here, or react :memo: on the goal post" glyph={GLYPH.state.needs} glyphColor={stateColor("needs", pulse())} />
            </Show>
            <Show when={session.id === props.model.reviewGoal()?.id}>
              <FieldText label="approval" value="A approves it here, or react :white_check_mark: on its proposal post" glyph={GLYPH.state.needs} glyphColor={stateColor("needs", pulse())} />
            </Show>
            <FieldText label="live view" value={connected && session.attach ? "a watch · D drive · " + RETURN_KEY + " back" : "not available"} color={connected && session.attach ? theme.text : theme.dim} />
            <Show when={session.recentActivity.length} fallback={<FieldText label="activity" value="No runtime activity recorded." color={theme.dim} />}>
              <For each={session.recentActivity.slice(0, 3)}>{(activity, index) => <FieldText label={index() ? "" : "activity"} value={GLYPH.bullet + " " + displayText(activity, 160)} />}</For>
            </Show>
          </box>
        )}</For>
        <Show when={connected && !sessions.some((session) => !!session.sessionId)}>
          <FieldText label="" value="No active runtime session occupies this seat." color={theme.dim} />
        </Show>
      </Section>
    );
  };

  const keyLine = () => input() ? (newGoalBlocked() ? "Start blocked · Esc cancel" : "Enter start · Esc cancel") + " · " + displayText(team()?.project?.github, 80) + " · home channel"
    : [page() === "teams" ? "↑↓ choose team · Enter open" : page() === "team" ? "↑↓ seat · Enter details · T retry · s restart · x stop · b teams" : `a watch · D drive (${RETURN_KEY} back) · t transcript · T retry · s restart · x stop · b team`,
      ...ceremonyKeys(), ...(newGoalBlocked() ? [] : ["n new goal"])].join(" · ");

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background} paddingLeft={1} paddingRight={1}>
      <box flexShrink={0} flexDirection="column">
        <box flexDirection="row" height={1}>
          <text flexGrow={1}>
            <span style={{ fg: theme.accent }}>INDRA</span>
            <span style={{ fg: theme.text }}>{"  " + GLYPH.crumb + "  " + (page() === "teams" ? "Teams" : displayText(team()?.displayName, 30)) + (page() === "seat" && seat() ? "  " + GLYPH.crumb + "  " + displayText(seat()?.displayName, 30) : "")}</span>
          </text>
          <text flexShrink={0}>
            <span style={{ fg: runtime().color }}>{GLYPH.dot + " "}</span>
            <span style={{ fg: theme.dim }}>{runtime().text}</span>
          </text>
        </box>
        <For each={statusRows()}>{(row) => <text fg={row.ok ? theme.dim : theme.bad}>{row.text}</text>}</For>
      </box>

      <Show when={page() === "teams"}>
        <scrollbox flexGrow={1} scrollY contentOptions={scrollContent}>
          <Section title="TEAMS">
            <Show when={props.model.teams.length} fallback={<text fg={theme.wait}>{props.model.stateError ? "No usable team state is available." : "No teams are recorded."}</text>}>
              <For each={props.model.teams}>{(item) => {
                const selected = () => { props.revision(); return props.model.teamId === item.id; };
                const occupied = () => { props.revision(); return props.model.sessionResult.connection === "connected"
                  ? item.seats.filter((member) => props.model.sessionResult.sessions.some((session) => session.teamId === item.id && session.seatId === member.id && session.sessionId)).length.toString()
                  : "unknown"; };
                return (
                  <text flexShrink={0} bg={selected() ? theme.selected : undefined}>
                    <span style={{ fg: theme.accent }}>{selected() ? GLYPH.selected + "   " : "    "}</span>
                    <span style={{ fg: selected() ? theme.accent : theme.text }}>{pad(clip(displayText(item.displayName, 30) + "  (" + displayText(item.slug, 30) + ")", 24), 24) + " "}</span>
                    <span style={{ fg: theme.dim }}>{item.seats.length + " seats  " + GLYPH.separator + "  " + occupied() + " in a session" + (item.project ? "  " + GLYPH.separator + "  " : "")}</span>
                    <span style={{ fg: theme.text }}>{item.project ? clip(GLYPH.pr + " " + displayText(item.project.github, 60), 30) : ""}</span>
                  </text>
                );
              }}</For>
            </Show>
          </Section>
        </scrollbox>
      </Show>

      <Show when={page() === "team" && !!team()}>
        <scrollbox id="team-scroll" ref={teamScroll} flexGrow={1} scrollY contentOptions={scrollContent}>
          <AttentionSection model={props.model} seats={team()?.seats ?? []} revision={props.revision} pulse={pulse} width={contentWidth} />
          <For each={sprints()}>{(sprint) => <SprintCard model={props.model} sprint={sprint} team={team()} session={sessionOf(sprint.id)} pulse={pulse} now={now} width={contentWidth} open={open} />}</For>
          <Section title={"SEATS " + GLYPH.separator + " " + displayText(team()?.displayName ?? "Team", 30) + " " + GLYPH.separator + " " + (team()?.seats.length ?? 0) + (teamCounts() ? "   " + teamCounts() : "")}>
            <Show when={team()?.seats.length} fallback={<text fg={theme.wait}>No seats are recorded for this team.</text>}>
              <SeatHeader width={contentWidth} />
              <For each={team()?.seats ?? []}>{(item) => <SeatRow model={props.model} seat={item} revision={props.revision} pulse={pulse} now={now} width={contentWidth} open={open} />}</For>
            </Show>
          </Section>
          <ActivitySection model={props.model} seats={team()?.seats ?? []} revision={props.revision} now={now} width={contentWidth} />
        </scrollbox>
      </Show>

      <Show when={page() === "seat"}>
        <scrollbox id="detail-scroll" ref={detailScroll} flexGrow={1} scrollY contentOptions={scrollContent}>
          <Show when={props.paneTail && seat()}>
            <PaneTailPanel source={props.paneTail!} seat={seat} width={() => contentWidth() - 2} lines={() => seatPaneLines(dimensions().height)} />
          </Show>
          {seatDetail()}
          <For each={sprints()}>{(sprint) => <SprintStrip sprint={sprint} team={team()} session={sessionOf(sprint.id)} pulse={pulse} open={open} />}</For>
        </scrollbox>
      </Show>

      <box flexShrink={0} flexDirection="column" border={["top"]} borderColor={theme.rule}>
        <Show when={newGoalHint()}><text fg={theme.dim} wrapMode="word">{displayText(newGoalHint(), 240)}</text></Show>
        <Show when={launchWarning()}>
          <text wrapMode="word"><span style={{ fg: stateColor("failed", pulse()) }}>{GLYPH.warn + " "}</span><span style={{ fg: theme.text }}>{displayText(launchWarning())}</span></text>
        </Show>
        <Show when={notice()}><text fg={theme.text} wrapMode="word">{displayText(notice())}</text></Show>
        <Show when={input()}>
          <text fg={theme.accent} wrapMode="char">
            New planning goal: {goalInputTail(input()?.value ?? "", dimensions().width)}▏
          </text>
          <text fg={theme.dim}>
            {(input()?.value.length ?? 0) >= GOAL_INPUT_LIMIT ? `Limit reached (${GOAL_INPUT_LIMIT} characters); extra characters are ignored.` : `${input()?.value.length ?? 0}/${GOAL_INPUT_LIMIT}`}
          </text>
        </Show>
        <Show when={confirm()}>
          <text wrapMode="word">
            <span style={{ fg: stateColor("needs", pulse()) }}>{GLYPH.state.needs + " "}</span>
            <span style={{ fg: theme.text }}>{confirmText(confirm()!, dimensions().width) + (confirm()?.action === "retry" ? " · n/Esc cancel" : " · any other key cancels")}</span>
          </text>
        </Show>
        <KeyLegend line={keyLine()} />
        <KeyLegend line={"? help · " + (paused() ? "Auto-update paused  ·  U resumes" : "Auto-update  ·  U pauses") + " · r checks now · R rolls back · q quits, seats keep running"} />
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
  /** Opens a seat's live view: `watch` with the pane's input off, `drive` with it on (only a verified headed run). */
  attach?: (target: string, mode?: AttachMode) => Promise<unknown>;
  /** Whether a seat's target is Indra's own verified session with a headed run going, so `D` can drive it. */
  driveCheck?: (target: string) => Promise<boolean>;
  /** Reads the running token totals of the headed runs still going. */
  liveUsage?: LiveUsagePort;
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
  model.liveUsagePort = options.liveUsage;
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
      else if (action === "attach" || action === "drive") {
        const target = model.attachTarget();
        if (!target) return;
        attaching = true;
        const name = model.seat?.displayName ?? "the seat";
        const watching = "Watching " + name + " · " + WATCH_HINT;
        let shown: string | undefined;
        let suspended = false;
        // Drive only a verified seat with a headed run going; the attach checks again and watches if that changed.
        void (action === "drive" ? (options.driveCheck ?? (async () => false))(target).catch(() => false) : Promise.resolve(false)).then((headed) => {
          if (!active) return;
          const mode: AttachMode = action === "drive" && headed ? "drive" : "watch";
          // Say how to get back before the screen switches to the seat.
          shown = mode === "drive" ? driveWarning(name) : action === "drive" ? driveFallback(name) : watching;
          model.notice = shown;
          model.revision++;
          setRevision(model.revision);
          return new Promise((wait) => setTimeout(wait, WATCH_HINT_MS)).then(() => {
            if (!active) return;
            suspended = true;
            renderer.suspend();
            return (options.attach ?? ((to: string, how?: AttachMode) => attachTmux(to, undefined, undefined, how)))(target, mode);
          });
        }).then(() => { if (model.notice === shown && !shown?.startsWith(name + " is not in a headed run")) model.notice = undefined; }, (error: unknown) => {
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
