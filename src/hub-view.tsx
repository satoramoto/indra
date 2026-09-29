import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js";
import type { StateSeat, StateTeam } from "./state-domain.js";
import { currentSession, displayText, newestPlanningRecord, sessionSprint, type TerminalSession, type TerminalSprint, type TerminalUiModel } from "./terminal-ui.js";
import { CEREMONY_STAGES, engineLabel, type SprintBuild, type SprintLoop, type SprintTicket } from "./session-snapshot.js";
import type { SeatLive } from "./supervisor.js";
import type { SeatHarness } from "./hub-facts.js";
import { isFinishedSprint } from "./finished-sprint.js";
import {
  CI_DOT, elapsedSince, formatElapsed, formatTokens, mattermostPostUrl, PIPELINE_ICON, pipelineSteps, prLabel, sumUsage, totalTokens, usageLine,
  type CiState, type PipelineStep, type StageState,
} from "./hub-format.js";
import type { TokenUsage } from "./runtime-facts.js";

/**
 * The hub's building blocks. Layout target: a 720×720 logical-pixel window (a vertical ultrawide at half height) with a
 * ~13 px terminal font, about 96 columns by 42 rows. Every screen fits that grid without scrolling; the scroll boxes
 * only matter on smaller terminals.
 */
export const HUB_GRID = { columns: 96, rows: 42 } as const;

export const theme = {
  background: "#0F172A", panel: "#1E293B", selected: "#1E3A5F", bar: "#312E81", barText: "#EEF2FF",
  border: "#475569", heading: "#E9D5FF", accent: "#67E8F9", regular: "#E5E7EB", muted: "#94A3B8", link: "#93C5FD",
  running: "#4ADE80", idle: "#FDE68A", error: "#F87171",
};

/** The five states the owner scans for, each with one colour and one icon everywhere. */
export type HubState = "running" | "waiting" | "needs" | "failed" | "done" | "idle";
export const HUB_STATE: Record<HubState, { icon: string; color: string; dim: string; pulse: boolean; word: string }> = {
  running: { icon: "🏃", color: "#4ADE80", dim: "#4ADE80", pulse: false, word: "running" },
  waiting: { icon: "⌛", color: "#FBBF24", dim: "#FBBF24", pulse: false, word: "waiting" },
  needs: { icon: "🙋", color: "#F472B6", dim: "#9D174D", pulse: true, word: "needs you" },
  failed: { icon: "💥", color: "#F87171", dim: "#7F1D1D", pulse: true, word: "failed" },
  done: { icon: "✅", color: "#60A5FA", dim: "#60A5FA", pulse: false, word: "done" },
  idle: { icon: "💤", color: "#94A3B8", dim: "#94A3B8", pulse: false, word: "idle" },
};
/** The colour of a state at this pulse phase; only needs-you and failed blink. */
export const stateColor = (state: HubState, pulse: boolean) => pulse && HUB_STATE[state].pulse ? HUB_STATE[state].dim : HUB_STATE[state].color;

const STEP_BG: Record<StageState, [string, string]> = {
  done: ["#14532D", "#14532D"], active: ["#A16207", "#422006"], failed: ["#991B1B", "#450A0A"], pending: ["", ""], skipped: ["", ""],
};
const STEP_FG: Record<StageState, string> = { done: "#4ADE80", active: "#FBBF24", failed: "#F87171", pending: "#475569", skipped: "#475569" };
/** Pending stages are a dim dot and a skipped fix is a dash, so the icons light up as the assignment advances. */
export const stepGlyph = (step: PipelineStep) => step.state === "pending" ? "◦ " : step.state === "skipped" ? "– " : PIPELINE_ICON[step.stage];

/**
 * One timer for every blinking thing: it flips a signal that only style attributes read, so a tick recolours existing
 * renderables and never rebuilds the tree (the lesson of #52: rebuilding creates native renderables faster than they
 * are freed). The clock ticks slower and only feeds elapsed-time text.
 */
export function createTicker(pulseMs = 700, clockMs = 15_000): { pulse: Accessor<boolean>; now: Accessor<number> } {
  const [pulse, setPulse] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const pulseTimer = setInterval(() => setPulse((value) => !value), pulseMs);
  const clockTimer = setInterval(() => setNow(Date.now()), clockMs);
  pulseTimer.unref?.(); clockTimer.unref?.();
  onCleanup(() => { clearInterval(pulseTimer); clearInterval(clockTimer); });
  return { pulse, now };
}

export function Pipeline(props: { steps: PipelineStep[]; pulse: Accessor<boolean> }) {
  return <For each={props.steps}>{(step) => (
    <span style={{ fg: STEP_FG[step.state], bg: STEP_BG[step.state][props.pulse() && step.state !== "done" ? 1 : 0] || undefined }}>{stepGlyph(step)}</span>
  )}</For>;
}

/** A link: an OSC 8 hyperlink where the terminal supports one, and a click that opens it with the system opener. */
export function LinkText(props: { url?: string; label: string; fg?: string; open?: (url: string) => void }) {
  return (
    <text flexShrink={0} fg={props.url ? props.fg ?? theme.link : theme.muted} onMouseUp={() => { if (props.url) props.open?.(props.url); }}>
      <Show when={props.url} fallback={props.label}><a href={props.url!}>{props.label}</a></Show>
    </text>
  );
}

export function occupancy(model: TerminalUiModel, seat: StateSeat): { label: string; color: string; session?: TerminalSession } {
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

export function activityLine(model: TerminalUiModel, seat: StateSeat, limit: number): string {
  const session = newestPlanningRecord(model.sessionsFor(seat.id));
  if (!session) return model.sessionResult.connection === "connected" ? "No recent runtime activity." : "Live activity unavailable.";
  const latest = session.recentActivity.at(-1);
  if (latest) return (model.sessionResult.connection === "connected" ? "Latest: " : "Recorded: ") + displayText(latest, limit);
  return "Planning goal: " + displayText(session.goal, limit) + " · stage: " + displayText((session.ceremony ?? session.loop?.ceremony)?.stage ?? "not recorded", 30);
}

export const processColor: Record<SeatLive["process"], string> = { running: theme.running, stopped: theme.idle, "no credential": theme.error, "no channel": theme.error };
export const isDeveloper = (seat: StateSeat) => seat.roles.includes("Developer");
export const processLabel = (live: SeatLive) => live.process.toUpperCase() + (live.updatePending ? " · UPDATE PENDING" : "");

export function assignmentLine(live: SeatLive, limit: number): string {
  const held = live.assignment;
  if (!held) return live.retry ? displayText(live.retry.title, limit) + " · failed · T retry" : "No assignment";
  return displayText(held.title, limit) + " · " + displayText(held.status, 20);
}

export function threadActivity(live: SeatLive, limit: number): string {
  return live.activity ? "Latest: " + displayText(live.activity.message, limit) : "No thread activity yet.";
}

export const harnessText = (harness: SeatHarness | undefined) => harness
  ? `${harness.engine === "claude" ? "Claude" : "Codex"} ${displayText(harness.model.replace(/^claude-/, ""), 30)}·${displayText(harness.effort, 10)}` : "harness unknown";

/** An open goal the owner has to act on: approve a proposal, merge an integration, revert or retro PR. */
export function needsOwner(session: TerminalSession): boolean {
  const loop = sessionSprint(session).loop;
  if (isFinishedSprint(loop)) return false;
  const stage = loop.ceremony?.stage;
  if (stage === "proposal" && session.stage === "awaiting-review") return true;
  if (loop.integration?.status === "pr-open" && !!loop.integration.prUrl) return true;
  if (loop.integration?.status === "merged" && !!loop.integration.revertPrUrl) return true;
  return stage === "retro" && loop.retro?.status === "pending" && !!loop.retro.prUrl;
}

/** One seat's state for colour, icon and blinking. */
export function seatState(model: TerminalUiModel, seat: StateSeat): HubState {
  const live = model.live[seat.id];
  if (live?.problem || live?.process === "no credential" || live?.process === "no channel") return "failed";
  if (isDeveloper(seat) && live) {
    const status = live.assignment?.status;
    if (status === "failed") return "failed";
    if (!live.assignment && live.retry) return "needs";
    if (status === "running" || status === "in-review") return "running";
    if (status === "queued" || live.process === "stopped") return "waiting";
    return "idle";
  }
  const records = model.sessionsFor(seat.id);
  const newest = newestPlanningRecord(records);
  if (model.sessionResult.connection === "connected" && newest?.status === "error") return "failed";
  if (records.some(needsOwner)) return "needs";
  if (currentSession(records)?.status === "running") return "running";
  if (live?.process === "stopped") return "waiting";
  return "idle";
}

/** Everything a seat row shows, computed once per revision. */
export interface SeatInfo {
  state: HubState; name: string; role: string; process?: string; harness: string;
  usage?: TokenUsage; claimedAt?: string; endedAt?: string;
  task?: { title: string; status: string; prUrl?: string; steps: PipelineStep[]; ci?: CiState };
  second: { text: string; color: string };
  activity: string;
}

export function seatInfo(model: TerminalUiModel, seat: StateSeat): SeatInfo {
  const live = model.live[seat.id];
  const state = seatState(model, seat);
  const developer = !!live && isDeveloper(seat);
  const held = developer ? live.assignment : undefined;
  const facts = held?.facts;
  const status = occupancy(model, seat);
  // A Developer's cost is its current assignment's; the lead's is its planning runs on open goals.
  // Both add the headed run still going, from its session log.
  const open = model.sessionsFor(seat.id).filter((session) => !isFinishedSprint(sessionSprint(session).loop));
  const usage = developer ? model.withLiveUsage(seat.id, facts?.usage, facts?.sessionIds ?? [])
    : model.withLiveUsage(seat.id, sumUsage(open.map((session) => session.usage)), open.map((session) => session.sessionId));
  const second = live?.problem ? { text: "⚠ " + displayText(live.problem, 300), color: theme.error }
    : developer ? held ? { text: "", color: theme.regular }
      : { text: (live.retry ? "🙋 " : "💤 ") + assignmentLine(live, 60), color: live.retry ? HUB_STATE.needs.color : theme.muted }
    : { text: status.label, color: status.color };
  return {
    state, name: displayText(seat.displayName, 40), role: displayText(seat.roles.join(", ") || "No role", 20),
    ...(live ? { process: processLabel(live) } : {}),
    harness: harnessText(live?.harness),
    ...(usage ? { usage } : {}),
    ...(facts?.claimedAt ? { claimedAt: facts.claimedAt } : {}),
    ...(facts?.endedAt ? { endedAt: facts.endedAt } : {}),
    ...(held ? { task: { title: displayText(held.title, 200), status: displayText(held.status, 20), prUrl: held.prUrl, ci: facts?.ci,
      steps: pipelineSteps({ status: held.status, step: facts?.step, fixRounds: facts?.fixRounds }) } } : {}),
    second,
    activity: developer ? threadActivity(live, 200) : activityLine(model, seat, 200),
  };
}

const pad = (text: string, width: number) => { const chars = Array.from(text); return chars.length >= width ? chars.slice(0, width).join("") : text + " ".repeat(width - chars.length); };
const clip = (text: string, width: number) => { const chars = Array.from(text); return chars.length <= width ? text : chars.slice(0, Math.max(1, width - 1)).join("") + "…"; };
const elapsedText = (info: { claimedAt?: string; endedAt?: string }, now: number) => {
  const end = info.endedAt ? Date.parse(info.endedAt) : now;
  return info.claimedAt ? formatElapsed(elapsedSince(info.claimedAt, end)) : "–";
};

/** Two rows per seat: who and how it runs, then what it is doing. */
export function SeatRow(props: { model: TerminalUiModel; seat: StateSeat; revision: Accessor<number>; pulse: Accessor<boolean>; now: Accessor<number>; width: Accessor<number>; open?: (url: string) => void }) {
  const info = createMemo(() => { props.revision(); return seatInfo(props.model, props.seat); });
  const selected = createMemo(() => { props.revision(); return props.model.seatId === props.seat.id; });
  // The second row's own text comes first; the latest activity gets what is left of the row.
  const secondWidth = () => Math.max(10, props.width() - 8);
  // A task row: indent, five pipeline icons, title, status, PR link and CI dot. The sprint card shows the title whole.
  const taskFixed = () => { const task = info().task!; return 5 + 10 + 1 + 3 + task.status.length + 1 + (task.prUrl ? 8 : 0) + (task.ci ? 3 : 0); };
  const titleRoom = () => Math.max(12, props.width() - taskFixed() - 1);
  const activityRoom = () => {
    const task = info().task;
    const used = task ? taskFixed() + Math.min(titleRoom(), Array.from(task.title).length) : 5 + Math.min(secondWidth(), Array.from(info().second.text).length) + 1;
    return Math.max(0, props.width() - used - 5);
  };
  // 96 columns hold every column; narrower screens drop the harness, then the elapsed time.
  const showHarness = () => props.width() >= 90;
  const showElapsed = () => props.width() >= 66;
  return (
    <box height={2} flexShrink={0} flexDirection="column" paddingLeft={1} backgroundColor={selected() ? theme.selected : theme.panel}>
      <text>
        <span style={{ fg: selected() ? theme.accent : theme.muted }}>{selected() ? "▶ " : "  "}</span>
        <span style={{ fg: stateColor(info().state, props.pulse()) }}>{HUB_STATE[info().state].icon + " "}</span>
        <span style={{ fg: selected() ? theme.accent : theme.regular }}>{pad(info().name, 15)}</span>
        <span style={{ fg: theme.muted }}>{" " + pad(info().role, 9)}</span>
        <span style={{ fg: stateColor(info().state, props.pulse()) }}>{" " + pad(info().process ?? HUB_STATE[info().state].word.toUpperCase(), 13)}</span>
        <span style={{ fg: theme.heading }}>{showHarness() ? " 🤖 " + pad(info().harness, 22) : ""}</span>
        <span style={{ fg: theme.idle }}>{showElapsed() ? " ⌛ " + pad(elapsedText(info(), props.now()), 6) : ""}</span>
        <span style={{ fg: theme.accent }}>{" 🧮 Σ" + formatTokens(totalTokens(info().usage))}</span>
      </text>
      <box flexDirection="row" height={1}>
        <Show when={info().task} fallback={<text fg={info().second.color} flexShrink={0}>{"     " + clip(info().second.text, secondWidth()) + " "}</text>}>
          <text flexShrink={0}>
            <span>{"     "}</span>
            <Pipeline steps={info().task!.steps} pulse={props.pulse} />
            <span style={{ fg: theme.regular }}>{" " + clip(info().task!.title, titleRoom()) + " · " + info().task!.status + " "}</span>
          </text>
          <Show when={info().task!.prUrl}><LinkText url={info().task!.prUrl} label={"🐙 " + (prLabel(info().task!.prUrl) ?? "PR")} open={props.open} /></Show>
          <Show when={info().task!.ci}><text flexShrink={0}>{" " + CI_DOT[info().task!.ci!]}</text></Show>
        </Show>
        <Show when={activityRoom() >= 12}><text fg={theme.muted} flexShrink={1}>{" 💬 " + clip(info().activity, activityRoom())}</text></Show>
      </box>
    </box>
  );
}

const buildStatus: Record<SprintBuild["status"], string> = {
  running: "Running build contains the integration commit.",
  "reload-pending": "Pending reload: available build contains the integration; running build does not.",
  "update-pending": "Update pending: running and available builds do not contain the integration.",
  unavailable: "Build evidence unavailable; release is not confirmed.",
  "revert-open": "Revert PR open; awaiting human merge confirmation.",
  reverted: "Reverted on main; running revert build is unverified.",
};

export function releaseDetail(loop: SprintLoop): string {
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

export function retroDetail(loop: SprintLoop): string {
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

function proposalDetail(sprint: TerminalSprint): string {
  const stage = sprint.loop.ceremony?.stage;
  if (!stage) return "Proposal progress: " + (sprint.planningStage ?? "not recorded") + ".";
  if (stage === "planning") return "Waiting for a proposal request.";
  if (stage !== "proposal") return "Plan approved.";
  return sprint.planningStage === "awaiting-review" ? "Draft ready; waiting for the owner's plan approval."
    : sprint.planningStage === "drafting" ? "Chick is drafting the proposal." : "Waiting for Chick's draft.";
}

/** Done stages green, the current one bracketed and blinking, later ones dim. */
function StageCycle(props: { loop: SprintLoop; pulse: Accessor<boolean> }) {
  const at = () => { const stage = props.loop.ceremony?.stage; return stage ? CEREMONY_STAGES.indexOf(stage) : -1; };
  return (
    <text wrapMode="word">
      <For each={CEREMONY_STAGES}>{(name, index) => <span style={{ fg: index() === at() ? props.pulse() ? theme.heading : theme.accent : index() < at() || props.loop.closedAt ? theme.running : theme.muted }}>
        {(index() ? " → " : "") + (index() === at() ? `[${name}]` : name)}
      </span>}</For>
    </text>
  );
}

const ticketState = (ticket: SprintTicket): HubState => ticket.status === "merged" ? "done" : ticket.status === "failed" ? "failed"
  : ticket.status === "building" || ticket.status === "in review" ? "running" : "waiting";

export interface SprintLinks { thread?: string; proposal?: string }

/** Mattermost links for a goal, from the team's slug and the post IDs Indra recorded. */
export function sprintLinks(team: StateTeam | undefined, session: TerminalSession | undefined): SprintLinks {
  const thread = mattermostPostUrl(team?.slug, session?.mattermost?.rootPostId);
  const proposal = mattermostPostUrl(team?.slug, session?.mattermost?.proposalPostId);
  return { ...(thread ? { thread } : {}), ...(proposal ? { proposal } : {}) };
}

function LinkRow(props: { links: SprintLinks; open?: (url: string) => void }) {
  return (
    <box flexDirection="row" height={1} flexShrink={0} gap={2}>
      <LinkText url={props.links.thread} label="💬 goal thread" open={props.open} />
      <LinkText url={props.links.proposal} label="📝 proposal post" open={props.open} />
    </box>
  );
}

/** The sprint panel on the team screen: the whole ceremony at a glance, one or two rows per part. */
export function SprintCard(props: { sprint: TerminalSprint; model: TerminalUiModel; team?: StateTeam; session?: TerminalSession; pulse: Accessor<boolean>; now: Accessor<number>; open?: (url: string) => void }) {
  const loop = () => props.sprint.loop;
  const stage = () => loop().ceremony?.stage;
  const closedAt = () => loop().ceremony?.closure?.closedAt ?? loop().closedAt;
  const retro = () => publishedRetro(loop()) ?? loop().retro;
  const started = () => loop().ceremony?.history.find((entry) => entry.enteredAt)?.enteredAt ?? props.session?.createdAt;
  const merged = () => loop().tickets.filter((ticket) => ticket.status === "merged").length;
  const seatName = (seatId: string) => displayText(props.team?.seats.find((seat) => seat.id === seatId)?.displayName ?? seatId, 30);
  const integrationUrl = () => loop().integration?.prUrl ?? loop().release?.prUrl;
  return <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1} border borderColor={theme.border} backgroundColor={theme.panel}
    title={" 🏁 SPRINT · " + displayText(props.sprint.id, 40) + " "} titleColor={theme.heading}>
    <text wrapMode="word">
      <span style={{ fg: theme.accent }}>Current stage: {stage() ?? "not recorded"}</span>
      <span style={{ fg: closedAt() ? theme.running : theme.idle }}>{" · Closure: " + (closedAt() ? "closed " + displayText(closedAt()) + " · completed sprint history" : "open")}</span>
      <span style={{ fg: theme.muted }}>{" · " + merged() + "/" + loop().tickets.length + " merged"}</span>
    </text>
    <StageCycle loop={loop()} pulse={props.pulse} />
    <Show when={!stage()}><text fg={theme.idle} wrapMode="word">Persisted ceremony unavailable; awaiting migration before ceremony actions.</text></Show>
    <text fg={theme.regular} wrapMode="word">🎯 {displayText(props.sprint.goal, 180)}</text>
    <LinkRow links={sprintLinks(props.team, props.session)} open={props.open} />
    <text fg={theme.accent}>{"🧮 Sprint total: " + usageLine(loop().usage) + " · ⌛ " + formatElapsed(elapsedSince(started(), closedAt() ? Date.parse(closedAt()!) : props.now())) + " since planning"}</text>
    <Show when={stage() === "planning"}><text fg={theme.regular}>🗣 Clarifying the goal.</text></Show>
    <text fg={props.sprint.planningStage === "awaiting-review" && stage() === "proposal" ? stateColor("needs", props.pulse()) : theme.regular} wrapMode="word">📝 {proposalDetail(props.sprint)}</text>
    <Show when={loop().tickets.length} fallback={<text fg={theme.muted}>No tickets assigned yet.</text>}>
      <For each={loop().tickets}>{(ticket) => {
        const state = ticketState(ticket);
        const steps = pipelineSteps({ status: ticket.status, step: ticket.facts?.step, fixRounds: ticket.facts?.fixRounds });
        return <box flexDirection="column" flexShrink={0}>
          <text wrapMode="word">
            <Pipeline steps={steps} pulse={props.pulse} />
            <span style={{ fg: stateColor(state, props.pulse()) }}>{" " + displayText(ticket.title, 8000) + " · " + ticket.status}</span>
          </text>
          <box flexDirection="row" height={1} flexShrink={0}>
            <text fg={theme.muted} flexShrink={0}>{"           👤 " + seatName(ticket.seatId) + " · "}</text>
            <LinkText url={ticket.prUrl} label={ticket.prUrl ? "🐙 " + (prLabel(ticket.prUrl) ?? "PR") : "PR not opened"} open={props.open} />
            <Show when={ticket.facts?.ci}><text flexShrink={0} fg={theme.muted}>{" · " + CI_DOT[ticket.facts!.ci!] + " CI " + ticket.facts!.ci}</text></Show>
            <Show when={ticket.facts?.usage}><text flexShrink={0} fg={theme.accent}>{" · 🧮 Σ" + formatTokens(totalTokens(ticket.facts!.usage))}</text></Show>
          </box>
        </box>;
      }}</For>
    </Show>
    <box flexDirection="row" height={1} flexShrink={0}>
      <text fg={theme.regular} flexShrink={0}>🚀 Integration PR: </text>
      <LinkText url={integrationUrl()} label={integrationUrl() ? "🐙 " + (prLabel(integrationUrl(), true) ?? displayText(integrationUrl(), 200)) : "not opened"} open={props.open} />
      <Show when={loop().integration?.revertPrUrl}>
        <text fg={theme.idle} flexShrink={0}> · Revert PR: </text>
        <LinkText url={loop().integration?.revertPrUrl} label={"🐙 " + (prLabel(loop().integration?.revertPrUrl, true) ?? "PR")} open={props.open} />
      </Show>
    </box>
    <text fg={loop().release ? theme.running : loop().integration?.status === "pr-open" ? stateColor("needs", props.pulse()) : theme.idle} wrapMode="word">   {displayText(releaseDetail(loop()), 2000)}</text>
    <Show when={loop().build}><text fg={loop().build?.status === "running" ? theme.running : theme.idle} wrapMode="word">   Current build: {displayText(loop().build?.reason || buildStatus[loop().build!.status], 2000)}</text></Show>
    <text fg={closedAt() ? theme.running : loop().retro?.prUrl ? stateColor("needs", props.pulse()) : theme.idle} wrapMode="word">📜 {retroDetail(loop())}</text>
    <Show when={retro()?.path || retro()?.prUrl}>
      <box flexDirection="row" height={1} flexShrink={0}>
        <Show when={retro()?.path}><text fg={theme.regular} flexShrink={0}>{"   Document: " + displayText(retro()?.path, 200) + " "}</text></Show>
        <Show when={retro()?.prUrl}><text fg={theme.regular} flexShrink={0}>· Retro PR: </text><LinkText url={retro()?.prUrl} label={"🐙 " + (prLabel(retro()?.prUrl, true) ?? "PR")} open={props.open} /></Show>
      </box>
    </Show>
  </box>;
}

/** The seat screen's short view of a sprint: where the ceremony is and what it waits for. */
export function SprintStrip(props: { sprint: TerminalSprint; team?: StateTeam; session?: TerminalSession; pulse: Accessor<boolean>; open?: (url: string) => void }) {
  const loop = () => props.sprint.loop;
  const stage = () => loop().ceremony?.stage;
  const closedAt = () => loop().ceremony?.closure?.closedAt ?? loop().closedAt;
  const detail = () => {
    const current = stage();
    if (!current || current === "planning" || current === "proposal") return "📝 " + proposalDetail(props.sprint);
    if (current === "implement") return "🔨 " + loop().tickets.filter((ticket) => ticket.status === "merged").length + "/" + loop().tickets.length + " tickets merged";
    if (current === "release") return "🚀 " + releaseDetail(loop());
    return "📜 " + retroDetail(loop());
  };
  return <box flexDirection="column" flexShrink={0} paddingLeft={1} border={["top"]} borderColor={theme.border} title={" 🏁 SPRINT · " + displayText(props.sprint.id, 40) + " "} titleColor={theme.heading}>
    <text wrapMode="word">
      <span style={{ fg: theme.accent }}>Current stage: {stage() ?? "not recorded"}</span>
      <span style={{ fg: closedAt() ? theme.running : theme.idle }}>{" · Closure: " + (closedAt() ? "closed " + displayText(closedAt()) : "open")}</span>
      <span style={{ fg: theme.accent }}>{" · 🧮 Σ" + formatTokens(totalTokens(loop().usage))}</span>
    </text>
    <StageCycle loop={loop()} pulse={props.pulse} />
    <text fg={theme.regular} wrapMode="word">{displayText(detail(), 300)}</text>
    <LinkRow links={sprintLinks(props.team, props.session)} open={props.open} />
  </box>;
}

/** The labelled pipeline on the seat screen: each stage named, lit as it advances. */
export function PipelineLabels(props: { steps: PipelineStep[]; pulse: Accessor<boolean> }) {
  const mark: Record<StageState, string> = { done: " ✓", active: " ●", failed: " ✗", pending: "", skipped: " skipped" };
  return <text>
    <For each={props.steps}>{(step, index) => <>
      <span style={{ fg: theme.muted }}>{index() ? "  →  " : ""}</span>
      <Pipeline steps={[step]} pulse={props.pulse} />
      <span style={{ fg: STEP_FG[step.state] === "#475569" ? theme.muted : STEP_FG[step.state] }}>{" " + step.stage + mark[step.state]}</span>
    </>}</For>
  </text>;
}

export { clip, elapsedText };
