import { execFile } from "node:child_process";
import { createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import { render, useKeyboard, usePaste, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import { createFrameClock, HeaderBar, IdleSplash } from "./hub-canvas.js";
import { supportsTruecolor, TokenBurn } from "./hub-paint.js";
import type { StateInventory } from "./state-domain.js";
import type { MouseEvent } from "@opentui/core";
import { displayText, GOAL_INPUT_LIMIT, sessionSprint, TerminalUiModel, TerminalUiWorkflow, type WorkflowEventSource, type FocusRegion, type KeyMods, type SessionReadPort, type StateSyncPort, type UiApproval, type UiRetry, type UiRollback, type UiView, type UpdatePort } from "./terminal-ui.js";
import { engineLabel } from "./session-snapshot.js";
import type { GoalStarter, SeatProcessPort } from "./supervisor.js";
import type { SessionPort } from "./session-mirror.js";
import { SessionDriver } from "./session-drive.js";
import { SessionPane, sessionPaneRows, type PaneMode } from "./session-pane.js";
import { shortcutContext, shortcutsFor, type Shortcut } from "./shortcuts.js";
import { keyInput } from "./key-batch.js";
import { HelpOverlay } from "./help-overlay.js";
import { TranscriptView } from "./transcript-view.js";
import type { TranscriptSource } from "./session-transcript.js";
import type { LiveUsagePort } from "./live-usage.js";
import { isFinishedSprint } from "./finished-sprint.js";
import { formatTokens, openableUrl, pipelineSteps, sumUsage, workTokens } from "./hub-format.js";
import { GLYPH } from "./hub-style.js";
import {
  ActivitySection, assignmentLine, AttentionSection, burnSparkline, CI_COLOR, clip, seatInfo, createTicker, elapsedText, Field, FieldText, HUB_STATE, isDeveloper, KeyLegend, LinkText, occupancy, pad,
  PipelineLabels, prText, processColor, SeatHeader, SeatRow, Section, seatState, SprintCard, SprintStrip, stateColor, stateCounts, theme, threadActivity, UsageSpans, WorkflowDetail,
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
    revert: ["Roll back sprint ", "y open a revert PR"],
  }[confirm.action];
  return question + displayText(confirm.goalId, 40) + " (" + displayText(confirm.goal, Math.max(10, width - 80)) + ")? " + yes
    + (confirm.prUrl ? "\nPR: " + displayText(confirm.prUrl, 2000) : "");
}

/** Columns of the seat list on the seat screen. */
export const SEAT_LIST_WIDTH = 22;

export interface TerminalAppProps {
  model: TerminalUiModel;
  revision: Accessor<number>;
  onKey: (name: string, ctrl?: boolean, text?: string, mods?: KeyMods) => void;
  /** A click on the seat screen: on a part of it (and a seat in the seat list), or outside every part. */
  onFocus?: (region: FocusRegion | undefined, seatId?: string) => void;
  /** The mouse wheel over the session pane: positive scrolls back. */
  onSessionScroll?: (lines: number) => void;
  /** A bracketed paste while driving a session. */
  onDrivePaste?: (text: string) => void;
  /** Mirrors the selected seat's live session while the seat screen is visible. */
  session?: Pick<SessionPort, "capture">;
  /** The session mirror's refresh interval; tests shorten it. */
  mirrorMs?: number;
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
  /** Seats per state for the seats title: the owner sees at once how many run, wait, need them or failed. */
  const teamCounts = createMemo(() => { props.revision(); return stateCounts(props.model, team()?.seats ?? []); });
  /** Content width inside the page's side padding. */
  const contentWidth = () => Math.max(20, dimensions().width - 3);
  /** One column on the right stays free for the scroll bar, so it never covers a row's last character. */
  const scrollContent = { paddingRight: 1 };

  let teamScroll: ScrollBoxRenderable | undefined;
  let detailScroll: ScrollBoxRenderable | undefined;
  let sprintScroll: ScrollBoxRenderable | undefined;
  useKeyboard((key) => {
    const model = props.model;
    const mods: KeyMods = { ctrl: key.ctrl, shift: key.shift, meta: key.meta || key.option };
    // While driving (or connecting to) the session, every key goes to the model, which forwards it.
    const free = !model.input && !model.confirm && !model.overlay && !(model.page === "seat" && model.focus === "session");
    const scroller = !free ? undefined : page() === "team" ? teamScroll : page() === "seat" ? (model.focus === "sprints" ? sprintScroll : model.focus === "details" ? detailScroll : undefined) : undefined;
    const lines = key.name === "pageup" || key.name === "pagedown" ? "viewport" : "absolute";
    const direction = key.name === "pageup" || key.name === "up" ? -1 : 1;
    if (scroller && (key.name === "pageup" || key.name === "pagedown" || (page() === "seat" && (key.name === "up" || key.name === "down")))) {
      if (lines === "viewport") scroller.scrollBy(direction, "viewport");
      else scroller.scrollBy(direction);
    } else props.onKey(key.name, key.ctrl, key.sequence, mods);
  });
  // A bracketed paste arrives as one event: it goes to the goal input, or to a session the owner drives; elsewhere it is ignored.
  usePaste((event) => {
    const text = new TextDecoder().decode(event.bytes);
    if (props.model.input) props.onKey("paste", false, text);
    else if (props.model.drivingOn()) props.onDrivePaste?.(text);
  });
  const focus = (region: FocusRegion | undefined, seatId?: string) => (event: MouseEvent) => {
    if (region) event.stopPropagation();
    if (props.onFocus) props.onFocus(region, seatId);
    else props.model.focusAt(region, seatId);
  };
  const focusedRegion = createMemo(() => { props.revision(); return page() === "seat" ? props.model.focus : undefined; });
  const regionBorder = (region: FocusRegion) => focusedRegion() === region ? theme.accent : theme.rule;
  const paneMode = createMemo<PaneMode>(() => {
    props.revision();
    const model = props.model;
    if (model.focus !== "session") return "watching";
    if (model.drivingOn()) return "driving";
    return model.driving ? "connecting" : "focused";
  });
  const shortcuts = createMemo<Shortcut[]>(() => {
    props.revision();
    const context = shortcutContext(props.model);
    const extra: Shortcut[] = [
      ...props.model.ceremonyKeys().map((label): Shortcut => [label.split(" ")[0]!, label.split(" ").slice(1).join(" ")]),
      ...(props.model.newGoalBlocked() || context === "teams" ? [] : [["n", "new goal"] as Shortcut]),
    ];
    return shortcutsFor(context, extra);
  });

  const seatDetail = () => {
    props.revision();
    const selected = seat();
    if (!selected) return <text fg={theme.dim}>Select a seat to inspect its runtime.</text>;
    const state = occupancy(props.model, selected);
    const hub = seatState(props.model, selected);
    const connected = props.model.sessionResult.connection === "connected";
    // Show current goals before historical records; whole-goal Developers use their runtime projection below.
    const records = [...props.model.sessionsFor(selected.id)].filter((session) => !session.workflowModel || selected.roles.includes("Team Lead")).sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    const openRecords = records.filter((session) => !isFinishedSprint(sessionSprint(session).loop));
    const sessions = (openRecords.length ? openRecords : records).slice(0, 2);
    const live = props.model.live[selected.id];
    const held = live?.goal ? undefined : live?.assignment;
    const facts = held?.facts;
    const leadUsage = props.model.withLiveUsage(selected.id, sumUsage(sessions.map((session) => session.usage)), sessions.map((session) => session.sessionId));
    const running = props.model.liveUsage[selected.id];
    const usage = isDeveloper(selected) ? props.model.withLiveUsage(selected.id, facts?.usage, facts?.sessionIds ?? []) : leadUsage;
    const sep = "  " + GLYPH.separator + "  ";
    return (
      <box flexDirection="column" flexShrink={0}>
        <text flexShrink={0}>
          <span style={{ fg: stateColor(hub, pulse()) }}>{"  " + HUB_STATE[hub].glyph + " "}</span>
          <span style={{ fg: theme.text }}>{displayText(selected.displayName) + "  @" + displayText(selected.handle)}</span>
          <span style={{ fg: theme.dim }}>{sep + displayText(selected.roles.join(", ") || "no role") + sep}</span>
          <span style={{ fg: stateColor(hub, pulse()) }}>{HUB_STATE[hub].word}</span>
        </text>
        <Show when={live}>
          <FieldText label="process" value={live!.process + (live!.updatePending ? " · update pending (restarts when idle)" : "") + (selected.roles.includes("Product") ? " (Product runner)" : isDeveloper(selected) ? " (seat runner)" : " (planning bridge)") + sep + "s restart" + sep + "x stop"}
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
        <FieldText label="burn" value={burnSparkline(seatInfo(props.model, selected), selected.id, now(), burn) + "  last hour"} color={theme.dim} />
        <WorkflowDetail live={live} open={open} />
        <Show when={props.model.team?.workflowModel === "goals-v1" && selected.roles.includes("Product") && !live?.product}><FieldText label="workflow" value="Product queue unavailable." color={theme.wait} /></Show>
        <Show when={props.model.team?.workflowModel === "goals-v1" && selected.roles.includes("Team Lead") && !live?.scheduler}><FieldText label="workflow" value="Scheduler queue unavailable." color={theme.wait} /></Show>
        <Show when={live && isDeveloper(selected) && !live.goal && props.model.team?.workflowModel !== "goals-v1"}>
          <FieldText label="historical" value={assignmentLine(live!, 160)} />
          <Show when={held}>
            <Field label="pr">
              <LinkText url={held?.prUrl} label={held?.prUrl ? prText(held?.prUrl, true) : "not opened"} open={open} />
              <text flexShrink={1} flexGrow={1} wrapMode="word">
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
            <FieldText label="detail" value={session.workflowModel ? displayText(session.stage) + sep + (session.goalOwnerSeatId ? "Developer " + displayText(session.goalOwnerSeatId) : "awaiting Developer assignment") : displayText(session.stage) + sep + (connected ? "" : "Last ") + engineLabel(session.engine) + " session: " + (displayText(session.sessionId) || "not started")
              + sep + (session.runs ?? 0) + " runs" + sep + "work " + formatTokens(workTokens(session.usage)) + sep + "updated " + (displayText(session.updatedAt) || "not reported")} />
            <Show when={session.id === props.model.clarifyingGoal()?.id}>
              <FieldText label="proposal" value="P requests Chick's proposal here, or react :memo: on the goal post" glyph={GLYPH.state.needs} glyphColor={stateColor("needs", pulse())} />
            </Show>
            <Show when={session.id === props.model.reviewGoal()?.id}>
              <FieldText label="approval" value="A approves it here, or react :white_check_mark: on its proposal post" glyph={GLYPH.state.needs} glyphColor={stateColor("needs", pulse())} />
            </Show>
            <FieldText label="live" value={connected && session.attach ? "shown above · i or a click on it drives" : "not available"} color={connected && session.attach ? theme.text : theme.dim} />
            <Show when={session.recentActivity.length} fallback={<FieldText label="activity" value="No runtime activity recorded." color={theme.dim} />}>
              <For each={session.recentActivity.slice(0, 3)}>{(activity, index) => <FieldText label={index() ? "" : "activity"} value={GLYPH.bullet + " " + displayText(activity, 160)} />}</For>
            </Show>
          </box>
        )}</For>
        <Show when={connected && !sessions.some((session) => !!session.sessionId)}>
          <FieldText label="" value="No active runtime session occupies this seat." color={theme.dim} />
        </Show>
      </box>
    );
  };

  const inputLine = () => (newGoalBlocked() ? "Start blocked" : "Goes to") + " · " + displayText(team()?.project?.github, 80) + " · home channel";
  const paneWidth = () => Math.max(20, dimensions().width - 2 - SEAT_LIST_WIDTH - 2);
  const paneRows = () => sessionPaneRows(dimensions().height);
  const mirrored = () => { props.revision(); return page() === "seat" && !props.model.overlay ? seat() : undefined; };

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background}>
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1} onMouseDown={focus(undefined)}>
      <box flexShrink={0} flexDirection="column">
        <HeaderBar frame={frame} drifting={sprintRunning} truecolor={truecolor()}>
          <text flexGrow={1}>
            <span style={{ fg: theme.accent }}>{" INDRA"}</span>
            <span style={{ fg: theme.text }}>{"  " + GLYPH.crumb + "  " + (page() === "teams" ? "Teams" : displayText(team()?.displayName, 30)) + (page() === "seat" && seat() ? "  " + GLYPH.crumb + "  " + displayText(seat()?.displayName, 30) : "")}</span>
          </text>
          <text flexShrink={0}>
            <span style={{ fg: runtime().color }}>{GLYPH.dot + " "}</span>
            <span style={{ fg: theme.dim }}>{runtime().text + " "}</span>
          </text>
        </HeaderBar>
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
          <For each={sprints()}>{(sprint) => <SprintCard model={props.model} sprint={sprint} team={team()} session={sessionOf(sprint.id)} pulse={pulse} now={now} width={contentWidth} open={open} truecolor={truecolor()} />}</For>
          <Section title={"SEATS " + GLYPH.separator + " " + displayText(team()?.displayName ?? "Team", 30) + " " + GLYPH.separator + " " + (team()?.seats.length ?? 0) + (teamCounts() ? "   " + teamCounts() : "")}>
            <Show when={team()?.seats.length} fallback={<text fg={theme.wait}>No seats are recorded for this team.</text>}>
              <SeatHeader width={contentWidth} />
              <For each={team()?.seats ?? []}>{(item) => <SeatRow model={props.model} seat={item} revision={props.revision} pulse={pulse} now={now} width={contentWidth} open={open} burn={burn} truecolor={truecolor()} />}</For>
            </Show>
          </Section>
          <ActivitySection model={props.model} seats={team()?.seats ?? []} revision={props.revision} now={now} width={contentWidth} />
          <Show when={splash()}>
            <IdleSplash frame={frame} width={contentWidth} truecolor={truecolor()} background={theme.background} caption="No sprint open" captionColor={theme.dim} />
          </Show>
        </scrollbox>
      </Show>

      <Show when={page() === "seat"}>
        <box flexGrow={1} flexDirection="row">
          <scrollbox id="seat-list" width={SEAT_LIST_WIDTH} flexShrink={0} scrollY border borderColor={regionBorder("seats")} title=" SEATS " titleColor={theme.accent} onMouseDown={focus("seats")}>
            <For each={team()?.seats ?? []}>{(item) => {
              const selected = () => { props.revision(); return props.model.seatId === item.id; };
              const state = () => { props.revision(); return seatState(props.model, item); };
              return (
                <box height={1} flexShrink={0} backgroundColor={selected() ? theme.selected : undefined} onMouseDown={focus("seats", item.id)}>
                  <text wrapMode="none">
                    <span style={{ fg: stateColor(state(), pulse()) }}>{HUB_STATE[state()].glyph + " "}</span>
                    <span style={{ fg: selected() ? theme.accent : theme.text }}>{displayText(item.displayName, SEAT_LIST_WIDTH - 6)}</span>
                  </text>
                </box>
              );
            }}</For>
          </scrollbox>
          <box flexGrow={1} flexDirection="column">
            <Show when={props.session && seat()}>
              <SessionPane source={props.session!} seat={mirrored} rows={paneRows} width={paneWidth} scroll={() => { props.revision(); return props.model.sessionScroll; }} mode={paneMode}
                onFocus={() => (props.onFocus ?? ((region: FocusRegion | undefined) => props.model.focusAt(region)))("session")}
                onScroll={(lines) => props.onSessionScroll ? props.onSessionScroll(lines) : props.model.scrollSession(lines)} intervalMs={props.mirrorMs} />
            </Show>
            <scrollbox id="detail-scroll" ref={detailScroll} flexGrow={2} scrollY border borderColor={regionBorder("details")} title={" SEAT " + displayText(seat()?.displayName, 40) + " "} titleColor={theme.accent} onMouseDown={focus("details")} contentOptions={scrollContent}>
              {seatDetail()}
            </scrollbox>
            <scrollbox id="sprint-scroll" ref={sprintScroll} flexGrow={1} scrollY border borderColor={regionBorder("sprints")} title=" SPRINTS " titleColor={theme.accent} onMouseDown={focus("sprints")} contentOptions={scrollContent}>
              <For each={sprints()} fallback={<text fg={theme.dim}>No open sprint.</text>}>{(sprint) => <SprintStrip sprint={sprint} team={team()} session={sessionOf(sprint.id)} pulse={pulse} open={open} />}</For>
            </scrollbox>
          </box>
        </box>
      </Show>

      <box flexShrink={0} flexDirection="column" border={["top"]} borderColor={theme.rule}>
        <Show when={props.model.workflowError}><text fg={theme.bad} wrapMode="word">{displayText(props.model.workflowError)}</text></Show>
        <Show when={newGoalHint()}><text fg={theme.dim} wrapMode="word">{displayText(newGoalHint(), 240)}</text></Show>
        <Show when={launchWarning()}>
          <text wrapMode="word"><span style={{ fg: stateColor("failed", pulse()) }}>{GLYPH.warn + " "}</span><span style={{ fg: theme.text }}>{displayText(launchWarning())}</span></text>
        </Show>
        <Show when={notice()}><text fg={theme.text} wrapMode="word">{displayText(notice())}</text></Show>
        <Show when={input()}>
          <text fg={theme.dim}>{inputLine()}</text>
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
        <Show when={!props.model.drivingOn() && (page() === "teams" || page() === "team")}>
          <KeyLegend line={(paused() ? "Auto-update paused · U resumes" : "Auto-update on · U pauses") + " · r checks now · R rolls back · q quits, seats keep running"} />
        </Show>
      </box>
      <Show when={overlay() === "help"}><HelpOverlay /></Show>
      <Show when={overlay() === "transcript" && seat()}>
        <TranscriptView source={props.transcript} seat={seat()!} recordedHandle={() => props.model.selectedSession()?.sessionId} />
      </Show>
    </box>
      <ShortcutBar shortcuts={shortcuts} driving={() => paneMode() === "driving"} />
    </box>
  );
}

/** The always-visible bar of the keys that apply right now; it turns the driving colour while the owner drives. */
export function ShortcutBar(props: { shortcuts: Accessor<Shortcut[]>; driving: Accessor<boolean> }) {
  return (
    <box id="shortcut-bar" flexShrink={0} flexDirection="row" flexWrap="wrap" paddingLeft={1} paddingRight={1} backgroundColor={theme.selected}>
      <For each={props.shortcuts()}>{([key, meaning], index) => (
        <text flexShrink={0}>
          <span style={{ fg: theme.dim }}>{index() ? " " + GLYPH.separator + " " : ""}</span>
          <span style={{ fg: props.driving() ? theme.wait : theme.accent }}>{key ? key + " " : ""}</span>
          <span style={{ fg: theme.dim }}>{meaning}</span>
        </text>
      )}</For>
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
  /** Host lifetime; every team has its own inbox consumer. Abort closes all sources. */
  workflowEvents?: WorkflowEventSource;
  /**
   * Mirrors the selected seat's live session in the seat screen, and drives it (verified pane, headed run only) while
   * the owner has focused the session pane.
   */
  session?: SessionPort;
  /** Reads the running token totals of the headed runs still going. */
  liveUsage?: LiveUsagePort;
  signal?: AbortSignal;
  /** Hosts and controls the bridge and seat runners; they keep running after the UI quits. */
  processes?: SeatProcessPort;
  goals?: GoalStarter;
  /** Syncs the state checkout with its remote before hosting processes, then every `syncMs` for callers without a workflow event source. */
  sync?: StateSyncPort;
  syncMs?: number;
  /** Pulls and builds new Indra code (every `updateMs` only for legacy callers); the UI reloads when `dist/` holds a newer build. */
  update?: UpdatePort;
  updateMs?: number;
  /** The view to open on, saved by the previous UI before a reload. */
  view?: UiView;
  /** Saves the view and returns the exit code that asks the launcher to start the UI again. */
  reload?: (view: UiView) => Promise<number>;
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

  let active = true;
  let refreshing = false;
  const publish = () => { if (active) { model.revision++; setRevision(model.revision); void workflow.wake(); } };
  const driver = options.session ? new SessionDriver(model, options.session, publish) : undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncTimer: ReturnType<typeof setInterval> | undefined;
  let updateTimer: ReturnType<typeof setInterval> | undefined;
  let reloadNow = () => {};
  const workflow = new TerminalUiWorkflow(model, options.workflowEvents, () => reloadNow());
  model.changed = () => { if (active) { setRevision(model.revision); driver?.sync(); void workflow.wake(); } };
  const refresh = async () => {
    if (!active || refreshing) return;
    refreshing = true;
    try {
      if (await model.refresh() && active) setRevision(model.revision);
      // A refresh can end driving (the seat left the state); the pane's input then goes back off.
      driver?.sync();
      // A new build (self-update or `npm run dev`) reloads the UI once nothing is in flight.
      if (await model.checkBuild() && model.readyToReload() && active && !model.driving) reloadNow();
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
    if (!active) return;
    const opened = openLink(url);
    model.notice = opened ? "Opened " + opened : "Not opened: that link is not a GitHub PR or an Indra Mattermost page.";
    model.revision++;
    setRevision(model.revision);
  };
  return await new Promise<number>((resolve, reject) => {
    let driveReleased: Promise<void> | undefined;
    const cleanup = (): boolean => {
      if (!active) return false;
      active = false;
      if (timer) clearInterval(timer);
      if (syncTimer) clearInterval(syncTimer);
      if (updateTimer) clearInterval(updateTimer);
      options.signal?.removeEventListener("abort", finish);
      // Quitting while driving switches the pane's input back off; the seat keeps running.
      driveReleased = driver?.release();
      renderer.destroy();
      return true;
    };
    const finish = () => { if (cleanup()) void Promise.all([workflow.stop(), driveReleased]).then(() => resolve(0), reject); };
    reloadNow = () => {
      const view = model.view();
      if (options.reload && cleanup()) void Promise.all([workflow.stop(), driveReleased]).then(() => options.reload!(view)).then(resolve, reject);
    };
    // One screen rebuild per stdin chunk, not per key: a burst of keys otherwise exhausts OpenTUI's native renderables.
    const applyKey = keyInput(model, (current) => { if (active) setRevision(current); });
    const key = (name: string, ctrl?: boolean, text?: string, mods: KeyMods = {}) => {
      if (!active) return;
      // Ctrl-C quits Indra, except while driving, when it goes to the session like every other key.
      if (ctrl && name === "c" && !(model.page === "seat" && model.focus === "session" && model.driving)) { finish(); return; }
      const action = applyKey(name, text, { ...mods, ctrl });
      if (action === "forward") driver?.key(name, text, { ...mods, ctrl });
      else if (action === "drive" || action === "release") driver?.sync();
      else if (action === "quit") finish();
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
      void workflow.wake();
    };
    const onFocus = (region: FocusRegion | undefined, seatId?: string) => {
      if (!active) return;
      model.focusAt(region, seatId);
      publish();
      driver?.sync();
    };
    const onSessionScroll = (lines: number) => { if (active) { model.scrollSession(lines); publish(); } };
    const onDrivePaste = (text: string) => { if (active) driver?.paste(text); };
    render(() => <TerminalApp model={model} revision={revision} onKey={key} onFocus={onFocus} onSessionScroll={onSessionScroll} onDrivePaste={onDrivePaste} session={options.session} transcript={options.transcript} openUrl={openUrl} />, renderer)
      .then(() => {
        if (!active) return;
        if (!options.workflowEvents) timer = setInterval(() => { void refresh(); }, Math.max(500, options.pollMs ?? 2000));
        void workflow.start().catch(() => { model.workflowError = "Startup reconciliation failed; restart Indra."; model.revision++; model.changed?.(); });
        if (!options.workflowEvents && options.sync) syncTimer = setInterval(() => { if (active) void model.syncState(); }, Math.max(5_000, options.syncMs ?? 60_000));
        if (!options.workflowEvents && options.update) updateTimer = setInterval(() => { if (active) void model.updateCode(); }, Math.max(5_000, options.updateMs ?? 60_000));
        options.signal?.addEventListener("abort", finish, { once: true });
        if (options.signal?.aborted) finish();
      })
      .catch((error: unknown) => { cleanup(); void Promise.all([workflow.stop(), driveReleased]).then(() => reject(error), reject); });
  });
}
