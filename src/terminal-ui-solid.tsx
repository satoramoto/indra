import { createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import { render, useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
import type { StateInventory, StateSeat } from "./state-domain.js";
import { attachTmux } from "./tmux-attach.js";
import { currentSession, displayText, GOAL_INPUT_LIMIT, newestPlanningRecord, TerminalUiModel, type SessionReadPort, type StateSyncPort, type TerminalSession, type TerminalSprint, type UiApproval, type UiRetry, type UiRollback, type UiView, type UpdatePort } from "./terminal-ui.js";
import { CEREMONY_STAGES, engineLabel, type SprintBuild, type SprintLoop } from "./session-snapshot.js";
import type { GoalStarter, SeatLive, SeatProcessPort } from "./supervisor.js";
import type { PaneTailSource } from "./pane-tail.js";
import { PaneTailPanel, paneTailLines } from "./pane-tail-panel.js";
import { keyInput } from "./key-batch.js";

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
    label: session.status.toUpperCase() + " SESSION · " + engineLabel(session.engine),
    color: session.status === "error" ? theme.error : session.status === "running" ? theme.running : theme.idle,
    session,
  };
}

/** The end of a long goal, as many characters as fit in six wrapped lines, so the cursor stays visible. */
function goalInputTail(value: string, width: number): string {
  const visible = Math.max(10, width - 2) * 6 - 20;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return clean.length > visible ? "…" + clean.slice(-(visible - 1)) : clean;
}

function activityLine(model: TerminalUiModel, seat: StateSeat, limit: number): string {
  const session = newestPlanningRecord(model.sessionsFor(seat.id));
  if (!session) return model.sessionResult.connection === "connected" ? "No recent runtime activity." : "Live activity unavailable.";
  const latest = session.recentActivity.at(-1);
  if (latest) return (model.sessionResult.connection === "connected" ? "Latest: " : "Recorded: ") + displayText(latest, limit);
  return "Planning goal: " + displayText(session.goal, limit) + " · stage: " + displayText((session.ceremony ?? session.loop?.ceremony)?.stage ?? "not recorded", 30);
}

const processColor: Record<SeatLive["process"], string> = { running: theme.running, stopped: theme.idle, "no credential": theme.error, "no channel": theme.error };
const isDeveloper = (seat: StateSeat) => seat.roles.includes("Developer");
const processLabel = (live: SeatLive) => live.process.toUpperCase() + (live.updatePending ? " · UPDATE PENDING" : "");

function assignmentLine(live: SeatLive, limit: number): string {
  const held = live.assignment;
  if (!held) return live.retry ? displayText(live.retry.title, limit) + " · failed · T retry" : "No assignment";
  return displayText(held.title, limit) + " · " + displayText(held.status, 20) + (held.prUrl ? " · " + displayText(held.prUrl, 120) : "");
}

function threadActivity(live: SeatLive, limit: number): string {
  return live.activity ? "Latest: " + displayText(live.activity.message, limit) : "No thread activity yet.";
}

const buildStatus: Record<SprintBuild["status"], string> = {
  running: "Running build contains the integration commit.",
  "reload-pending": "Pending reload: available build contains the integration; running build does not.",
  "update-pending": "Update pending: running and available builds do not contain the integration.",
  unavailable: "Build evidence unavailable; release is not confirmed.",
  "revert-open": "Revert PR open; awaiting human merge confirmation.",
  reverted: "Reverted on main; running revert build is unverified.",
};

function releaseDetail(loop: SprintLoop): string {
  if (loop.release) return `Release confirmed running ${loop.release.runningAt} · application ${loop.release.runningSha.slice(0, 7)} · bridge ${loop.release.buildSha.slice(0, 7)}.`;
  if (!loop.ceremony) return "Release completion is not recorded.";
  if (["planning", "proposal", "implement"].includes(loop.ceremony.stage)) return "Waiting for implementation to finish.";
  if (!loop.integration || loop.integration.status === "collecting") return "Release waiting: integration PR has not opened.";
  if (loop.integration.status === "pr-open") return "Release waiting: integration PR needs the owner's merge and green CI.";
  if (loop.build?.status === "running") return "Build is running; waiting for the recorded transition to retro.";
  return "Release waiting: " + (loop.build?.reason || (loop.build ? buildStatus[loop.build.status] : "running application and bridge evidence is unavailable."));
}

/** The closure's retro evidence; a reverted release or a migrated legacy goal closes without one. */
function publishedRetro(loop: SprintLoop) {
  const evidence = loop.ceremony?.closure?.evidence;
  return evidence && (evidence.kind === undefined || evidence.kind === "retro-published") ? evidence : undefined;
}

function retroDetail(loop: SprintLoop): string {
  const kind = loop.ceremony?.closure?.evidence.kind;
  if (kind === "release-reverted") return "No retro: the release was reverted before it ran.";
  if (kind === "legacy-migration") return "No retro: finished before the ceremony; closed by legacy migration.";
  const published = publishedRetro(loop);
  if (published) return `Published ${published.publishedAt}.`;
  if (loop.retro?.status === "published") return "Publication recorded; waiting for goal closure.";
  if (loop.ceremony?.stage !== "retro") return "Waiting for the released build to be confirmed running.";
  if (loop.retro?.prUrl) return "Retro waiting: PR needs the owner's merge, green CI and publication.";
  return "Retro waiting: Chick's draft and publication PR have not been recorded.";
}

function SprintCard(props: { sprint: TerminalSprint; model: TerminalUiModel }) {
  const loop = () => props.sprint.loop;
  const stage = () => loop().ceremony?.stage;
  const closedAt = () => loop().ceremony?.closure?.closedAt ?? loop().closedAt;
  const retro = () => publishedRetro(loop()) ?? loop().retro;
  const proposal = () => {
    if (!stage()) return "Proposal progress: " + (props.sprint.planningStage ?? "not recorded") + ".";
    if (stage() === "planning") return "Waiting for a proposal request.";
    if (stage() !== "proposal") return "Plan approved.";
    return props.sprint.planningStage === "awaiting-review" ? "Draft ready; waiting for the owner's plan approval."
      : props.sprint.planningStage === "drafting" ? "Chick is drafting the proposal." : "Waiting for Chick's draft.";
  };
  return <box flexDirection="column" flexShrink={0} padding={1} border borderColor="#42536B" backgroundColor={theme.panel}>
    <text fg={theme.heading} wrapMode="char">SPRINT ·{displayText(props.sprint.id)}</text>
    <text fg={theme.accent}>Current stage: {stage() ?? "not recorded"}</text>
    <text wrapMode="word">
      <For each={CEREMONY_STAGES}>{(name, index) => <span style={{ fg: name === stage() ? theme.accent : theme.muted }}>
        {(index() ? " → " : "") + (name === stage() ? `[${name}]` : name)}
      </span>}</For>
    </text>
    <text fg={closedAt() ? theme.running : theme.idle} wrapMode="word">Closure: {closedAt() ? "closed " + displayText(closedAt()) + " · completed sprint history" : "open"}</text>
    <Show when={!stage()}><text fg={theme.idle} wrapMode="word">Persisted ceremony unavailable; awaiting migration before ceremony actions.</text></Show>
    <text fg={theme.regular} wrapMode="word">{displayText(props.sprint.goal, 160)}</text>
    <text fg={theme.heading}>planning · clarification</text>
    <text fg={theme.regular}>{stage() === "planning" ? "Clarifying the goal." : loop().ceremony?.history.some((entry) => entry.stage === "planning") ? "Clarification recorded." : "Not recorded."}</text>
    <text fg={theme.heading}>proposal · draft and owner review</text>
    <text fg={theme.regular} wrapMode="word">{proposal()}</text>
    <text fg={theme.heading}>implement · build, review and fix</text>
    <Show when={loop().tickets.length} fallback={<text fg={theme.muted}>No tickets assigned yet.</text>}>
      <For each={loop().tickets}>{(ticket) => <box flexDirection="column" flexShrink={0} paddingLeft={1}>
        <text fg={ticket.status === "failed" ? theme.error : ticket.status === "merged" ? theme.running : theme.regular} wrapMode="word">{displayText(ticket.title, 8000)} · {ticket.status}</text>
        <text fg={theme.muted} wrapMode="word">Seat: {displayText(props.model.team?.seats.find((seat) => seat.id === ticket.seatId)?.displayName ?? ticket.seatId)} ({displayText(ticket.seatId)})</text>
        <text fg={theme.muted} wrapMode="char">PR: {displayText(ticket.prUrl, 2000) || "not opened"}</text>
      </box>}</For>
    </Show>
    <text fg={theme.heading}>release · integration and update</text>
    <text fg={theme.regular} wrapMode="char">Integration PR: {displayText(loop().integration?.prUrl ?? loop().release?.prUrl, 2000) || "not opened"}</text>
    <Show when={loop().integration?.revertPrUrl}><text fg={theme.idle} wrapMode="char">Revert PR: {displayText(loop().integration?.revertPrUrl, 2000)}</text></Show>
    <text fg={loop().release ? theme.running : theme.idle} wrapMode="word">{displayText(releaseDetail(loop()), 2000)}</text>
    <Show when={loop().build}><text fg={loop().build?.status === "running" ? theme.running : theme.idle} wrapMode="word">Current build: {displayText(loop().build?.reason || buildStatus[loop().build!.status], 2000)}</text></Show>
    <text fg={theme.heading}>retro · draft and publication</text>
    <text fg={closedAt() ? theme.running : theme.idle} wrapMode="word">{retroDetail(loop())}</text>
    <Show when={retro()?.path}><text fg={theme.regular} wrapMode="char">Document: {displayText(retro()?.path, 2000)}</text></Show>
    <Show when={retro()?.prUrl}><text fg={theme.regular} wrapMode="char">Retro PR: {displayText(retro()?.prUrl, 2000)}</text></Show>
  </box>;
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

export interface TerminalAppProps {
  model: TerminalUiModel;
  revision: Accessor<number>;
  onKey: (name: string, ctrl?: boolean, text?: string) => void;
  /** Reads the selected seat's live pane while its detail is visible. */
  paneTail?: PaneTailSource;
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
  const launchWarning = createMemo(() => { props.revision(); return props.model.launchWarning; });
  const sync = createMemo(() => { props.revision(); return props.model.syncLine(); });
  const update = createMemo(() => { props.revision(); return props.model.updateLine(); });

  const input = createMemo(() => { props.revision(); return props.model.input ? { ...props.model.input } : undefined; });
  const confirm = createMemo(() => { props.revision(); return props.model.confirm ? { ...props.model.confirm } : undefined; });
  const paused = createMemo(() => { props.revision(); return props.model.paused; });
  const sprints = createMemo(() => { props.revision(); return props.model.sprintsForTeam(); });
  const hasPlanningLoops = createMemo(() => sprints().length > 0);
  const newGoalBlocked = createMemo(() => { props.revision(); return props.model.newGoalBlocked(); });
  const newGoalHint = createMemo(() => {
    props.revision();
    const open = props.model.openGoals();
    return newGoalBlocked() && open.length ? "New goal blocked: " + open.map((goal) => goal.id).join(", ") + " still open." : newGoalBlocked();
  });
  const ceremonyKeys = createMemo(() => { props.revision(); return props.model.ceremonyKeys(); });

  let teamScroll: ScrollBoxRenderable | undefined;
  let sprintScroll: ScrollBoxRenderable | undefined;
  let detailScroll: ScrollBoxRenderable | undefined;
  useKeyboard((key) => {
    if (!props.model.input && !props.model.confirm && (key.name === "pageup" || key.name === "pagedown")) {
      const target = page() === "seat" ? detailScroll : page() === "team" ? wide() ? sprintScroll : teamScroll : undefined;
      target?.scrollBy(key.name === "pageup" ? -1 : 1, "viewport");
    } else props.onKey(key.name, key.ctrl, key.sequence);
  });
  // A bracketed paste arrives as one event; only the goal input takes text, so a paste elsewhere is ignored.
  usePaste((event) => { if (props.model.input) props.onKey("paste", false, new TextDecoder().decode(event.bytes)); });
  const paneTail = (panelWidth: () => number) => (
    <Show when={props.paneTail && seat()}>
      <PaneTailPanel source={props.paneTail!} seat={seat} width={panelWidth} lines={() => paneTailLines(dimensions().height)} />
    </Show>
  );

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
              <Show when={live.retry}><text fg={theme.idle}>T retries {displayText(live.retry?.goalId, 40)}/{displayText(live.retry?.outcomeId, 40)}: {displayText(live.retry?.title, 120)} (confirm first)</text></Show>
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
            <text fg={theme.regular}>Planning detail: {displayText(session.stage)}  ·  {props.model.sessionResult.connection === "connected" ? "" : "Last "}{engineLabel(session.engine)} session: {displayText(session.sessionId) || "not started"}</text>
            <text fg={theme.muted}>Updated: {displayText(session.updatedAt) || "not reported"}</text>
            <Show when={session.id === props.model.clarifyingGoal()?.id}>
              <text fg={theme.idle}>P requests Chick's proposal here, or react :memo: on the goal post</text>
            </Show>
            <Show when={session.id === props.model.reviewGoal()?.id}>
              <text fg={theme.idle}>A approves it here, or react :white_check_mark: on its proposal post</text>
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
        <Show when={page() === "seat"}><For each={sprints()}>{(sprint) => <SprintCard model={props.model} sprint={sprint} />}</For></Show>
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
          <scrollbox id="team-scroll" ref={teamScroll} flexGrow={1} width={wide() ? "62%" : "100%"} scrollY border borderColor="#42536B" title={(team()?.displayName ?? "Team") + " · " + (team()?.seats.length ?? 0) + " STABLE SEATS"} titleColor={theme.accent}>
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
                      {"  "}{!wide() && problem() ? problem() : !wide() && (dev()?.assignment || dev()?.retry) ? assignmentLine(dev()!, 60) : activity()}
                    </text>
                  </box>
                );
              }}</For>
            </Show>
            <Show when={!wide()}><For each={sprints()}>{(sprint) => <SprintCard model={props.model} sprint={sprint} />}</For></Show>
          </scrollbox>
          <Show when={wide()}><scrollbox id="sprint-scroll" ref={sprintScroll} width="38%" height="100%" scrollY>
            {paneTail(() => Math.floor((dimensions().width - 2) * 0.38) - 6)}
            <Show when={!hasPlanningLoops()}>{seatDetail()}</Show>
            <For each={sprints()}>{(sprint) => <SprintCard model={props.model} sprint={sprint} />}</For>
          </scrollbox></Show>
        </box>
      </Show>

      <Show when={page() === "seat"}>
        <scrollbox id="detail-scroll" ref={detailScroll} flexGrow={1} scrollY>{paneTail(() => dimensions().width - 8)}{seatDetail()}</scrollbox>
      </Show>

      <box flexShrink={0} flexDirection="column">
        <Show when={hasPlanningLoops() && page() !== "teams"}><text fg={theme.muted}>PgUp/PgDn scroll sprint history</text></Show>
        <Show when={newGoalHint()}><text fg={theme.idle} wrapMode="word">{displayText(newGoalHint(), 240)}</text></Show>
        <Show when={launchWarning()}><text fg={theme.error} wrapMode="word">{displayText(launchWarning())}</text></Show>
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
          <text fg={theme.heading} wrapMode="word">{confirmText(confirm()!, dimensions().width)}{confirm()?.action === "retry" ? " · n/Esc cancel" : " · any other key cancels"}</text>
        </Show>
        <text fg={theme.accent} wrapMode="word">
          {input() ? (newGoalBlocked() ? "Start blocked · Esc cancel" : "Enter start · Esc cancel") + " · " + displayText(team()?.project?.github, 80) + " · home channel"
            : [page() === "teams" ? "↑↓ choose team · Enter open" : page() === "team" ? "↑↓ seat · Enter details · T retry · s restart · x stop · b teams" : "a attach · T retry · s restart · x stop · b team",
              ...ceremonyKeys(), ...(newGoalBlocked() ? [] : ["n new goal"]), "q quit"].join(" · ")}
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
  /** Reads the selected seat's live pane while its detail is visible. */
  paneTail?: PaneTailSource;
  /** Returns a warning when Indra was launched under ttyd or its seats' tmux server cannot be verified. */
  launchCheck?: () => Promise<string | undefined>;
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
    render(() => <TerminalApp model={model} revision={revision} onKey={key} paneTail={options.paneTail} />, renderer)
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
