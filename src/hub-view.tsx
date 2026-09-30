import { createMemo, createSignal, For, onCleanup, Show, type Accessor, type JSX } from "solid-js";
import type { StateSeat, StateTeam } from "./state-domain.js";
import { currentSession, displayText, newestPlanningRecord, sessionSprint, type TerminalSession, type TerminalSprint, type TerminalUiModel } from "./terminal-ui.js";
import { CEREMONY_STAGES, engineLabel, type SprintBuild, type SprintLoop, type SprintTicket } from "./session-snapshot.js";
import type { SeatLive } from "./supervisor.js";
import type { SeatHarness } from "./hub-facts.js";
import { isFinishedSprint } from "./finished-sprint.js";
import {
  compactionNote, CONTEXT_WARN_SHARE, contextText, elapsedSince, formatElapsed, formatTokens, mattermostPostUrl, pipelineSteps, prLabel, sumUsage, workTokens,
  type CiState, type PipelineStep, type StageState,
} from "./hub-format.js";
import { faded, GLYPH, PALETTE, PULSE_MS } from "./hub-style.js";
import { HARNESS_CONTEXT_TOKEN_LIMIT } from "./harness-home.js";
import type { TokenUsage } from "./runtime-facts.js";
import { burnBuckets, paintHex, sparkline, sprintProgress, STAGE_COLOR, type TokenBurn } from "./hub-paint.js";
import { ProgressBar } from "./hub-canvas.js";
import { totalTokens } from "./hub-format.js";

/** Burn is a secondary detail: dim, like the other secondary figures. */
const SPARK_COLOR = PALETTE.dim;

/**
 * The hub's building blocks. Layout target: a 720×720 logical-pixel window (a vertical ultrawide at half height) with a
 * ~13 px terminal font, about 96 columns by 42 rows. Every screen fits that grid without scrolling; the scroll boxes
 * only matter on smaller terminals.
 *
 * Every screen is built from the same parts, in the same order: a section rule with its title, then rows that share
 * one grid. A row's first four columns are a gutter for the selection and a state glyph; labels and names start at
 * column four.
 */
export const HUB_GRID = { columns: 96, rows: 42 } as const;

/** The palette under the names the screens use. */
export const theme = PALETTE;

/** The states the owner scans for, each with one glyph and one colour everywhere. */
export type HubState = "running" | "waiting" | "needs" | "failed" | "done" | "idle";
export const HUB_STATE: Record<HubState, { glyph: string; color: string; pulse: boolean; word: string }> = {
  running: { glyph: GLYPH.state.running, color: PALETTE.wait, pulse: false, word: "running" },
  waiting: { glyph: GLYPH.state.waiting, color: PALETTE.wait, pulse: false, word: "waiting" },
  needs: { glyph: GLYPH.state.needs, color: PALETTE.bad, pulse: true, word: "needs you" },
  failed: { glyph: GLYPH.state.failed, color: PALETTE.bad, pulse: true, word: "failed" },
  done: { glyph: GLYPH.state.done, color: PALETTE.ok, pulse: false, word: "done" },
  idle: { glyph: GLYPH.state.idle, color: PALETTE.dim, pulse: false, word: "idle" },
};
/** The colour of a state at this pulse phase; only what needs the owner (needs you, failed) pulses. */
export const stateColor = (state: HubState, pulse: boolean) => pulse && HUB_STATE[state].pulse ? faded(HUB_STATE[state].color) : HUB_STATE[state].color;

const STEP_COLOR: Record<StageState, string> = { done: PALETTE.ok, active: PALETTE.wait, failed: PALETTE.bad, pending: PALETTE.dim, skipped: PALETTE.dim };
/** A stage's colour; the one active stage is the only one that pulses. */
export const stepColor = (state: StageState, pulse: boolean) => pulse && state === "active" ? faded(STEP_COLOR.active) : STEP_COLOR[state];
export const stepGlyph = (step: PipelineStep) => GLYPH.stage[step.state];
export const CI_COLOR: Record<CiState, string> = { passed: PALETTE.ok, pending: PALETTE.wait, failed: PALETTE.bad };

/**
 * One timer for the pulse: it flips a signal that only style attributes read, so a tick recolours existing
 * renderables and never rebuilds the tree (the lesson of #52: rebuilding creates native renderables faster than they
 * are freed). The clock ticks slower and only feeds elapsed-time text.
 */
export function createTicker(pulseMs = PULSE_MS, clockMs = 15_000): { pulse: Accessor<boolean>; now: Accessor<number> } {
  const [pulse, setPulse] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const pulseTimer = setInterval(() => setPulse((value) => !value), pulseMs);
  const clockTimer = setInterval(() => setNow(Date.now()), clockMs);
  pulseTimer.unref?.(); clockTimer.unref?.();
  onCleanup(() => { clearInterval(pulseTimer); clearInterval(clockTimer); });
  return { pulse, now };
}

/** Five one-column glyphs, build to merge: ■ done, ◧ active, □ pending, ─ skipped, ✗ failed. */
export function Pipeline(props: { steps: PipelineStep[]; pulse: Accessor<boolean> }) {
  return <For each={props.steps}>{(step) => <span style={{ fg: stepColor(step.state, props.pulse()) }}>{stepGlyph(step)}</span>}</For>;
}

/** A link: an OSC 8 hyperlink where the terminal supports one, and a click that opens it with the system opener. */
export function LinkText(props: { url?: string; label: string; fg?: string; open?: (url: string) => void }) {
  return (
    <text flexShrink={0} fg={props.url ? props.fg ?? theme.link : theme.dim} onMouseUp={() => { if (props.url) props.open?.(props.url); }}>
      <Show when={props.url} fallback={props.label}><a href={props.url!}>{props.label}</a></Show>
    </text>
  );
}

/** `⎇ #103`, or `⎇ owner/repo#103` with `repo`. */
export const prText = (url: string | undefined, repo = false) => GLYPH.pr + " " + (prLabel(url, repo) ?? "PR");

const pad = (text: string, width: number) => { const chars = Array.from(text); return chars.length >= width ? chars.slice(0, width).join("") : text + " ".repeat(width - chars.length); };
const padStart = (text: string, width: number) => { const chars = Array.from(text); return chars.length >= width ? chars.slice(0, width).join("") : " ".repeat(width - chars.length) + text; };
const clip = (text: string, width: number) => { const chars = Array.from(text); return chars.length <= width ? text : chars.slice(0, Math.max(1, width - 1)).join("") + "…"; };
const elapsedText = (info: { claimedAt?: string; endedAt?: string }, now: number) => {
  const end = info.endedAt ? Date.parse(info.endedAt) : now;
  return info.claimedAt ? formatElapsed(elapsedSince(info.claimedAt, end)) : "–";
};

/** A major section: one rule with the title in the accent colour. The only border the hub draws. */
export function Section(props: { title: string; id?: string; children?: JSX.Element }) {
  return (
    <box id={props.id} flexDirection="column" flexShrink={0} border={["top"]} borderColor={theme.rule} title={" " + props.title + " "} titleColor={theme.accent}>
      {props.children}
    </box>
  );
}

const KEY_WORDS = new Set(["Enter", "Esc", "PgUp", "PgDn"]);

/** The footer's key legend: each item's key in the accent, its meaning dim, the text itself unchanged. */
export function KeyLegend(props: { line: string }) {
  const parts = () => props.line.split(/( +· +)/).map((part, index) => {
    if (index % 2) return { key: "", rest: part };
    const [first = "", ...rest] = part.split(" ");
    return Array.from(first).length <= 2 || KEY_WORDS.has(first) ? { key: first, rest: rest.length ? " " + rest.join(" ") : "" } : { key: "", rest: part };
  });
  return (
    <text wrapMode="word" flexShrink={0}>
      <For each={parts()}>{(part) => <><span style={{ fg: theme.accent }}>{part.key}</span><span style={{ fg: theme.dim }}>{part.rest}</span></>}</For>
    </text>
  );
}

/** Label column width; every labelled row on every screen uses it. */
export const LABEL_WIDTH = 11;

/** A labelled row: the gutter (with an optional state glyph), a dim label, then the value, which may wrap. */
export function Field(props: { label: string; glyph?: string; glyphColor?: string; children?: JSX.Element }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text flexShrink={0} wrapMode="none">
        <span style={{ fg: props.glyphColor ?? theme.dim }}>{"  " + (props.glyph ?? " ") + " "}</span>
        <span style={{ fg: theme.dim }}>{pad(props.label, LABEL_WIDTH) + " "}</span>
      </text>
      {props.children}
    </box>
  );
}

/** A labelled row whose value is plain text. */
export function FieldText(props: { label: string; value: string; color?: string; glyph?: string; glyphColor?: string }) {
  return (
    <Field label={props.label} glyph={props.glyph} glyphColor={props.glyphColor}>
      <text fg={props.color ?? theme.text} wrapMode="word" flexGrow={1} flexShrink={1}>{props.value}</text>
    </Field>
  );
}

export function occupancy(model: TerminalUiModel, seat: StateSeat): { label: string; color: string; session?: TerminalSession } {
  const records = model.sessionsFor(seat.id);
  const session = currentSession(records);
  const newest = newestPlanningRecord(records);
  if (model.team?.workflowModel === "goals-v1") {
    const live = model.liveUsage[seat.id];
    return live ? { label: "running session · " + engineLabel(live.engine), color: theme.text }
      : { label: "current session evidence unavailable", color: theme.dim };
  }
  if (model.sessionResult.connection !== "connected") return { label: "occupancy unknown", color: theme.wait, session: newest };
  if (newest?.status === "error" && !newest.sessionId) return { label: records.some((record) => !!record.sessionId) ? "runtime error · saved session" : "runtime record error", color: theme.bad, session: newest };
  if (!session?.sessionId) return { label: "no active session", color: theme.dim, session };
  return {
    label: session.status + " session · " + engineLabel(session.engine),
    color: session.status === "error" ? theme.bad : theme.text,
    session,
  };
}

/** A lead seat's newest runtime activity, without a prefix: the section or label says what it is. */
export function activityLine(model: TerminalUiModel, seat: StateSeat, limit: number): string {
  const session = newestPlanningRecord(model.sessionsFor(seat.id));
  if (!session) return model.sessionResult.connection === "connected" ? "No recent runtime activity." : "Live activity unavailable.";
  const latest = session.recentActivity.at(-1);
  if (latest) return (model.sessionResult.connection === "connected" ? "" : "Recorded: ") + displayText(latest, limit);
  return "Planning goal: " + displayText(session.goal, limit) + " · stage: " + displayText((session.ceremony ?? session.loop?.ceremony)?.stage ?? "not recorded", 30);
}

export const processColor: Record<SeatLive["process"], string> = { running: theme.ok, stopped: theme.wait, "no credential": theme.bad, "no channel": theme.bad };
export const isDeveloper = (seat: StateSeat) => seat.roles.includes("Developer");
export const processLabel = (live: SeatLive) => live.process + (live.updatePending ? " · update pending" : "");

export function assignmentLine(live: SeatLive, limit: number): string {
  const held = live.assignment;
  if (!held) return live.retry ? displayText(live.retry.title, limit) + " · failed · T retry" : "No assignment";
  return displayText(held.title, limit) + " · " + displayText(held.status, 20);
}

/** A Developer seat's newest thread post. */
export function threadActivity(live: SeatLive, limit: number): string {
  return live.activity ? displayText(live.activity.message, limit) : "No thread activity yet.";
}

/** The seats table's model column: `gpt-6-sol`, `opus-5-5`. The seat screen names the harness, model and effort in full. */
export const harnessText = (harness: SeatHarness | undefined) => harness ? displayText(harness.model.replace(/^claude-/, ""), 30) : "–";

const ROLE_SHORT: Record<string, string> = { "Team Lead": "lead", Developer: "dev", Product: "prod" };
export const roleShort = (roles: readonly string[]) => roles.length ? roles.map((role) => ROLE_SHORT[role] ?? displayText(role, 10).toLowerCase()).join("+") : "–";

/** Only the initial proposal waits on human approval. */
export function ownerAction(session: TerminalSession): string | undefined {
  const loop = sessionSprint(session).loop;
  if (isFinishedSprint(loop)) return undefined;
  const stage = loop.ceremony?.stage;
  const id = displayText(session.id, 40);
  if (stage === "proposal" && session.stage === "awaiting-review") return `Proposal for ${id} waits for your plan approval`;
  return undefined;
}

/** An open goal the owner has to act on. */
export const needsOwner = (session: TerminalSession): boolean => !!ownerAction(session);

/** One seat's state for its glyph and colour. */
export function seatState(model: TerminalUiModel, seat: StateSeat): HubState {
  const live = model.live[seat.id];
  if (live?.problem || live?.process === "no credential" || live?.process === "no channel") return "failed";
  if (live?.goal) return live.goal.progress?.failure || live.goal.status === "failed" ? "failed" : live.goal.status === "running" ? "running" : "waiting";
  if (live?.product) return live.product.failure ? "failed" : live.product.queue.some((item) => item.status === "posted") ? "needs" : live.product.queue.length ? "waiting" : "idle";
  if (live?.scheduler) return live.scheduler.failure ? "failed" : live.scheduler.activeDispatches.length ? "running" : live.scheduler.approvedQueue.length ? "waiting" : "idle";
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

/** Everything a seat's rows show, computed once per revision. */
export interface SeatInfo {
  state: HubState; name: string; role: string; harness: string;
  usage?: TokenUsage; claimedAt?: string; endedAt?: string;
  /** The live session's context window and its newest compaction, while a headed run is going. */
  context?: number; compactedAt?: string;
  /** Recorded sessions' tokens by finish time, for the burn sparkline; live rises fill in where there are none. */
  burn: { at: number; tokens: number }[];
  /** The seats table's task column. */
  task: { text: string; color: string };
  steps?: PipelineStep[]; prUrl?: string; ci?: CiState;
  /** Why the seat needs the owner, for the section at the top. */
  attention?: string;
  /** The newest activity, for the log at the bottom. */
  latest: string;
}

export function seatInfo(model: TerminalUiModel, seat: StateSeat): SeatInfo {
  const live = model.live[seat.id];
  const state = seatState(model, seat);
  const developer = !!live && isDeveloper(seat);
  const held = developer && !live.goal ? live.assignment : undefined;
  const facts = held?.facts;
  const status = occupancy(model, seat);
  const records = model.sessionsFor(seat.id);
  // A Developer's cost is its current assignment's; the lead's is its planning runs on open goals.
  // Both add the headed run still going, from its session log.
  const open = records.filter((session) => !isFinishedSprint(sessionSprint(session).loop));
  const usage = developer ? model.withLiveUsage(seat.id, facts?.usage, facts?.sessionIds ?? [])
    : model.withLiveUsage(seat.id, sumUsage(open.map((session) => session.usage)), open.map((session) => session.sessionId));
  const processDown = !!live && live.process !== "running";
  const workflow = live?.goal ? `Goal ${live.goal.goalId}: ${live.goal.title} · ${live.goal.status}`
    : live?.product ? `${live.product.queue.filter((entry) => entry.status !== "approved").length} ranked proposals`
    : live?.scheduler ? `${live.scheduler.approvedQueue.length} approved queued · ${live.scheduler.activeDispatches.length} active · ${live.scheduler.approvedQueue.filter((entry) => entry.blockedByGoalIds.length).length} overlap blockers`
    : model.team?.workflowModel === "goals-v1" ? seat.roles.includes("Product") ? "Product queue unavailable" : seat.roles.includes("Team Lead") ? "Scheduler queue unavailable" : "No current goal" : undefined;
  const task = workflow ? { text: displayText(workflow, 300), color: theme.text } : held ? { text: displayText(held.title, 200), color: held.status === "failed" ? theme.bad : theme.text }
    : processDown ? { text: processLabel(live), color: processColor[live.process] }
    : developer ? live.retry ? { text: "failed · T retry", color: theme.bad } : { text: "no assignment", color: theme.dim }
    : { text: status.label, color: status.color === theme.text ? theme.dim : status.color };
  const attention = state !== "needs" && state !== "failed" ? undefined
    : live?.problem ? displayText(live.problem, 300)
    : live?.goal?.progress?.failure ? displayText(live.goal.progress.failure.message)
    : live?.scheduler?.failure ? displayText(live.scheduler.failure.message)
    : live?.product?.failure ? displayText(live.product.failure.message)
    : held?.status === "failed" ? displayText(held.title, 200) + " · failed"
    : developer && live.retry ? assignmentLine(live, 200)
    : records.map(ownerAction).find(Boolean) ?? (processDown ? processLabel(live) : status.label);
  const running = model.liveUsage[seat.id];
  return {
    state, name: displayText(seat.displayName, 40), role: roleShort(seat.roles), harness: harnessText(live?.harness), task,
    ...(usage ? { usage } : {}),
    ...(running?.context !== undefined ? { context: running.context } : {}),
    ...(running?.compactedAt ? { compactedAt: running.compactedAt } : {}),
    ...(facts?.claimedAt ? { claimedAt: facts.claimedAt } : {}),
    ...(facts?.endedAt ? { endedAt: facts.endedAt } : {}),
    burn: (facts?.burn ?? []).map((point) => ({ at: Date.parse(point.at), tokens: point.tokens })),
    ...(held ? { steps: pipelineSteps({ status: held.status, step: facts?.step, fixRounds: facts?.fixRounds }), prUrl: held.prUrl, ci: facts?.ci } : {}),
    ...(attention ? { attention } : {}),
    latest: developer ? threadActivity(live, 200) : activityLine(model, seat, 200),
  };
}

/** Shared records, displayed on the actual seat page; old outcome records remain separate. */
export function WorkflowDetail(props: { live?: SeatLive; open?: (url: string) => void }) {
  return <>
    <Show when={props.live?.goal}>{(goal) => <box flexDirection="column" flexShrink={0}>
      <text fg={theme.text} wrapMode="word">Current goal: {displayText(goal().goalId)} · {displayText(goal().title)} · {displayText(goal().status)}</text>
      <text fg={theme.dim} wrapMode="word">Owned files: {displayText(goal().ownedFiles.join(", "), 2000)}</text>
      <Show when={goal().progress} fallback={<text fg={theme.wait}>Lane progress unavailable.</text>}>
        <For each={goal().progress?.lanes}>{(lane) => <box flexDirection="row" flexShrink={0}>
          <text fg={theme.text}>{displayText(lane.id)} · {lane.status} · CI {lane.ci} · </text>
          <LinkText url={lane.prUrl ?? undefined} label={lane.prUrl ? prLabel(lane.prUrl) ?? "PR" : "PR not opened"} open={props.open} />
        </box>}</For>
        <Show when={goal().progress?.failure}><text fg={theme.bad} wrapMode="word">{displayText(goal().progress?.failure?.message)}</text></Show>
        <For each={goal().progress?.decisions}>{(text) => <text wrapMode="word" fg={theme.text}>Decision: {displayText(text)}</text>}</For>
        <For each={goal().progress?.followUps}>{(text) => <text wrapMode="word" fg={theme.dim}>Follow-up: {displayText(text)}</text>}</For>
        <For each={goal().progress?.neededButUnowned}>{(text) => <text wrapMode="word" fg={theme.wait}>Needed but unowned: {displayText(text)}</text>}</For>
      </Show>
    </box>}</Show>
    <Show when={props.live?.scheduler}>{(scheduler) => <box flexDirection="column" flexShrink={0}>
      <text fg={theme.text}>Scheduler · approved queue and active goals</text>
      <For each={[...scheduler().approvedQueue].sort((a, b) => a.rank - b.rank)}>{(goal) => <text fg={theme.text} wrapMode="word">{goal.rank}. {displayText(goal.goalId)} · {goal.blockedByGoalIds.length ? "overlap blocked by " + displayText(goal.blockedByGoalIds.join(", ")) : "waiting for an idle Developer"}</text>}</For>
      <For each={scheduler().activeDispatches}>{(goal) => <text fg={theme.text}>{displayText(goal.goalId)} → {displayText(goal.seatId)} · {goal.status}</text>}</For>
      <Show when={scheduler().failure}><text fg={theme.bad} wrapMode="word">{displayText(scheduler().failure?.message)}</text></Show>
    </box>}</Show>
    <Show when={props.live?.product}>{(product) => <box flexDirection="column" flexShrink={0}>
      <text fg={theme.text}>Product · ranked proposed queue</text>
      <For each={[...product().queue].filter((item) => item.status !== "approved").sort((a, b) => a.proposal.rank - b.proposal.rank)}>{(item) => <text fg={theme.text} wrapMode="word">{item.proposal.rank}. {displayText(item.proposal.summary)} · {item.status === "posted" ? "awaiting owner approval" : "proposed"}</text>}</For>
      <Show when={product().failure}><text fg={theme.bad} wrapMode="word">{displayText(product().failure?.message)}</text></Show>
    </box>}</Show>
  </>;
}

/** The window's colour: neutral, yellow above CONTEXT_WARN_SHARE of the cap. */
export const contextColor = (context: number | undefined) => context !== undefined && context > CONTEXT_WARN_SHARE * HARNESS_CONTEXT_TOKEN_LIMIT ? theme.wait : theme.text;

/**
 * Tokens as spans, one shape everywhere: fresh work first in plain text, then output, then cache re-reads dim, then
 * the live context window against the cap and a recent compaction.
 */
export function UsageSpans(props: { usage?: TokenUsage; context?: number; compactedAt?: string; now: Accessor<number> }) {
  const note = () => compactionNote(props.compactedAt, props.now());
  return <>
    <span style={{ fg: theme.text }}>{props.usage ? "work " + formatTokens(workTokens(props.usage)) : "no tokens recorded yet"}</span>
    <span style={{ fg: theme.text }}>{props.usage ? " " + GLYPH.separator + " out " + formatTokens(props.usage.outputTokens) : ""}</span>
    <span style={{ fg: theme.dim }}>{props.usage ? " " + GLYPH.separator + " cache " + formatTokens(props.usage.cachedInputTokens) : ""}</span>
    <span style={{ fg: contextColor(props.context) }}>{props.context !== undefined ? " " + GLYPH.separator + " " + contextText(props.context, HARNESS_CONTEXT_TOKEN_LIMIT) : ""}</span>
    <span style={{ fg: theme.wait }}>{note() ? " " + GLYPH.separator + " " + note() : ""}</span>
  </>;
}

/**
 * The seats table's columns, left to right: selection, state, seat, role, task, steps, model, work, out, cache, ctx,
 * time, PR and CI. At 96 columns the role moves to the seat screen; narrower screens drop the model, then the time.
 * The task takes what is left.
 */
export interface SeatColumns { task: number; role: boolean; model: boolean; time: boolean; detail: boolean; burn: boolean }
export const SEAT_WIDTH = { name: 13, role: 4, steps: 5, model: 11, work: 5, out: 5, cache: 5, ctx: 4, time: 5, burn: 4, pr: 8 } as const;
export function seatColumns(width: number): SeatColumns {
  const role = width >= 104;
  // The burn sparkline needs room the 96-column grid does not have; the seat screen always shows it.
  const burn = width >= 100;
  const model = width >= 88;
  // Below 72 columns only fresh work stays; output, cache and the window move to the seat screen.
  const detail = width >= 72;
  const time = width >= 64;
  const w = SEAT_WIDTH;
  // Gutter (4), then each column and the space after it; PR and CI share the last one.
  const fixed = 4 + (w.name + 1) + (role ? w.role + 1 : 0) + 1 + (w.steps + 1) + (model ? w.model + 1 : 0)
    + (w.work + 1) + (detail ? w.out + 1 + w.cache + 1 + w.ctx + 1 : 0) + (time ? w.time + 1 : 0) + (burn ? w.burn + 1 : 0) + w.pr;
  return { role, model, time, detail, burn, task: Math.max(8, width - fixed) };
}

/** The dim header row over the seats table. */
export function SeatHeader(props: { width: Accessor<number> }) {
  const cols = () => seatColumns(props.width());
  const w = SEAT_WIDTH;
  return (
    <text fg={theme.dim} flexShrink={0} wrapMode="none">
      {"    " + pad("SEAT", w.name) + " " + (cols().role ? pad("ROLE", w.role) + " " : "") + pad("TASK", cols().task) + " " + pad("STEPS", w.steps) + " "
        + (cols().model ? pad("MODEL", w.model) + " " : "") + padStart("WORK", w.work) + " "
        + (cols().detail ? padStart("OUT", w.out) + " " + padStart("CACHE", w.cache) + " " + padStart("CTX", w.ctx) + " " : "") + (cols().time ? padStart("TIME", w.time) + " " : "") + (cols().burn ? pad("BURN", w.burn) + " " : "") + pad("PR", w.pr - 2) + "CI"}
    </text>
  );
}

/**
 * The last hour of a seat's token burn in eight 7.5-minute buckets, four braille cells: recorded sessions from before
 * the hub opened, then the rises it has seen in the seat's running total, the headed run in progress included.
 */
export function burnSparkline(info: SeatInfo, key: string, now: number, burn?: TokenBurn): string {
  burn?.observe(key, totalTokens(info.usage), now);
  return sparkline(burnBuckets(burn ? burn.series(key, info.burn) : info.burn, now, 8));
}

/** One aligned row per seat. From 100 columns it also shows the last hour's burn. */
export function SeatRow(props: { model: TerminalUiModel; seat: StateSeat; revision: Accessor<number>; pulse: Accessor<boolean>; now: Accessor<number>; width: Accessor<number>; open?: (url: string) => void; burn?: TokenBurn; truecolor?: boolean }) {
  const info = createMemo(() => { props.revision(); return seatInfo(props.model, props.seat); });
  // Observed on every look, shown when the table has room for it.
  const spark = createMemo(() => burnSparkline(info(), props.seat.id, props.now(), props.burn));
  const selected = createMemo(() => { props.revision(); return props.model.seatId === props.seat.id; });
  const cols = () => seatColumns(props.width());
  const w = SEAT_WIDTH;
  const pr = () => info().prUrl ? prText(info().prUrl) : "";
  return (
    <box height={1} flexShrink={0} flexDirection="row" backgroundColor={selected() ? theme.selected : undefined}>
      <text flexShrink={0} wrapMode="none">
        <span style={{ fg: theme.accent }}>{selected() ? GLYPH.selected + " " : "  "}</span>
        <span style={{ fg: stateColor(info().state, props.pulse()) }}>{HUB_STATE[info().state].glyph + " "}</span>
        <span style={{ fg: selected() ? theme.accent : theme.text }}>{pad(info().name, w.name) + " "}</span>
        <span style={{ fg: theme.dim }}>{cols().role ? pad(info().role, w.role) + " " : ""}</span>
        <span style={{ fg: info().task.color }}>{pad(clip(info().task.text, cols().task), cols().task) + " "}</span>
        <Pipeline steps={info().steps ?? []} pulse={props.pulse} />
        <span style={{ fg: theme.dim }}>{(info().steps ? "" : " ".repeat(w.steps)) + " " + (cols().model ? pad(clip(info().harness, w.model), w.model) + " " : "")}</span>
        <span style={{ fg: theme.text }}>{padStart(formatTokens(workTokens(info().usage)), w.work) + " " + (cols().detail ? padStart(formatTokens(info().usage?.outputTokens), w.out) + " " : "")}</span>
        <span style={{ fg: theme.dim }}>{cols().detail ? padStart(formatTokens(info().usage?.cachedInputTokens), w.cache) + " " : ""}</span>
        <span style={{ fg: contextColor(info().context) }}>{cols().detail ? padStart(formatTokens(info().context), w.ctx) + " " : ""}</span>
        <span style={{ fg: theme.dim }}>{cols().time ? padStart(elapsedText(info(), props.now()), w.time) + " " : ""}</span>
        <span style={{ fg: paintHex(SPARK_COLOR, props.truecolor ?? true) }}>{cols().burn ? pad(spark(), w.burn) + " " : ""}</span>
      </text>
      <Show when={info().prUrl}><LinkText url={info().prUrl} label={pr()} open={props.open} /></Show>
      <text flexShrink={0} wrapMode="none">
        <span>{" ".repeat(Math.max(1, w.pr - 1 - Array.from(pr()).length))}</span>
        <span style={{ fg: info().ci ? CI_COLOR[info().ci!] : theme.dim }}>{info().ci ? GLYPH.ci : ""}</span>
      </text>
    </box>
  );
}

/** Seats per state, for the seats section's title: the legend and the count in one. */
export function stateCounts(model: TerminalUiModel, seats: readonly StateSeat[]): string {
  const counts = new Map<HubState, number>();
  for (const seat of seats) { const state = seatState(model, seat); counts.set(state, (counts.get(state) ?? 0) + 1); }
  return (["running", "waiting", "needs", "failed", "idle"] as HubState[]).filter((state) => counts.get(state))
    .map((state) => HUB_STATE[state].glyph + " " + counts.get(state) + " " + HUB_STATE[state].word).join("  ");
}

/** The top of the team screen: each seat that needs the owner, and why. Just the rule when nothing does. */
export function AttentionSection(props: { model: TerminalUiModel; seats: readonly StateSeat[]; revision: Accessor<number>; pulse: Accessor<boolean>; width: Accessor<number> }) {
  const infos = createMemo(() => { props.revision(); return props.seats.map((seat) => seatInfo(props.model, seat)); });
  const count = () => infos().filter((info) => info.attention).length;
  return (
    <Section title={"NEEDS YOU · " + (count() || "nothing")}>
      <For each={props.seats}>{(_, index) => (
        <Show when={infos()[index()]?.attention}>
          <text flexShrink={0} wrapMode="none">
            <span style={{ fg: stateColor(infos()[index()].state, props.pulse()) }}>{"  " + HUB_STATE[infos()[index()].state].glyph + " "}</span>
            <span style={{ fg: theme.text }}>{pad(infos()[index()].name, SEAT_WIDTH.name) + " "}</span>
            <span style={{ fg: theme.text }}>{clip(infos()[index()].attention ?? "", Math.max(10, props.width() - 18))}</span>
          </text>
        </Show>
      )}</For>
    </Section>
  );
}

/** The bottom of the team screen: each seat's newest activity, one row each. */
export function ActivitySection(props: { model: TerminalUiModel; seats: readonly StateSeat[]; revision: Accessor<number>; now: Accessor<number>; width: Accessor<number> }) {
  return (
    <Section title="LATEST">
      <For each={props.seats}>{(seat) => {
        const info = createMemo(() => { props.revision(); return seatInfo(props.model, seat); });
        // A compaction is noted here for a few minutes: the context window just shrank.
        const note = () => { const text = compactionNote(info().compactedAt, props.now()); return text ? "context " + text + " " + GLYPH.separator + " " : ""; };
        return (
          <text flexShrink={0} wrapMode="none">
            <span style={{ fg: theme.dim }}>{"    " + pad(info().name, SEAT_WIDTH.name) + " "}</span>
            <span style={{ fg: theme.wait }}>{note()}</span>
            <span style={{ fg: theme.text }}>{clip(info().latest, Math.max(10, props.width() - 18 - note().length))}</span>
          </text>
        );
      }}</For>
    </Section>
  );
}

const buildStatus: Record<SprintBuild["status"], string> = {
  running: "Running build contains the integration commit.",
  "reload-pending": "Pending reload: available build contains the integration; running build does not.",
  "update-pending": "Update pending: running and available builds do not contain the integration.",
  unavailable: "Build evidence unavailable; release is not confirmed.",
  "revert-open": "Revert PR open; awaiting bot review and green CI.",
  reverted: "Reverted on main; running revert build is unverified.",
};

export function releaseDetail(loop: SprintLoop): string {
  if (loop.release) return `Release confirmed running ${loop.release.runningAt} · application ${loop.release.runningSha.slice(0, 7)} · bridge ${loop.release.buildSha.slice(0, 7)}.`;
  if (!loop.ceremony) return "Release completion is not recorded.";
  if (["planning", "proposal", "implement"].includes(loop.ceremony.stage)) return "Waiting for implementation to finish.";
  if (!loop.integration || loop.integration.status === "collecting") return "Release waiting: integration PR has not opened.";
  if (loop.integration.status === "pr-open") return "Release waiting: integration PR needs current-head bot approval and green CI.";
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
  if (kind === "remodel-closure") return "No retro fabricated: historical goal closed for the remodel.";
  if (kind === "legacy-migration") return "No retro: finished before the ceremony; closed by legacy migration.";
  const published = publishedRetro(loop);
  if (published) return `Published ${published.publishedAt}.`;
  if (loop.retro?.status === "published") return "Publication recorded; waiting for goal closure.";
  if (loop.ceremony?.stage !== "retro") return "Waiting for the released build to be confirmed running.";
  if (loop.retro?.prUrl) return "Retro waiting: PR needs current-head bot approval, green CI and verified publication.";
  return "Retro waiting: Chick's draft and publication PR have not been recorded.";
}

function proposalDetail(sprint: TerminalSprint): string {
  const stage = sprint.loop.ceremony?.stage;
  if (!stage) return "Proposal progress: " + (sprint.planningStage ?? "not recorded") + ".";
  if (stage === "planning") return "Clarifying the goal; waiting for a proposal request.";
  if (stage !== "proposal") return "Plan approved.";
  return sprint.planningStage === "awaiting-review" ? "Draft ready; waiting for the owner's plan approval."
    : sprint.planningStage === "drafting" ? "Chick is drafting the proposal." : "Waiting for Chick's draft.";
}

/** Done stages in plain text, the current one bracketed in the accent, later ones dim. Static: nothing here pulses. */
function StageCycle(props: { loop: SprintLoop }) {
  const at = () => { const stage = props.loop.ceremony?.stage; return stage ? CEREMONY_STAGES.indexOf(stage) : -1; };
  return (
    <For each={CEREMONY_STAGES}>{(name, index) => <span style={{ fg: index() === at() ? theme.accent : index() < at() || props.loop.closedAt ? theme.text : theme.dim }}>
      {(index() ? " " + GLYPH.arrow + " " : "") + (index() === at() ? `[${name}]` : name)}
    </span>}</For>
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
    <Field label="links">
      <LinkText url={props.links.thread} label={GLYPH.link + " goal thread"} open={props.open} />
      <text flexShrink={0}>{"   "}</text>
      <LinkText url={props.links.proposal} label={GLYPH.link + " proposal post"} open={props.open} />
    </Field>
  );
}

/** The stages row: where the ceremony is, whether the goal is closed, and how many tickets merged. */
function StagesField(props: { loop: SprintLoop; tail?: string }) {
  const closedAt = () => props.loop.ceremony?.closure?.closedAt ?? props.loop.closedAt;
  return (
    <Field label="stages" glyph={closedAt() ? GLYPH.state.done : undefined} glyphColor={theme.ok}>
      <text wrapMode="word" flexGrow={1} flexShrink={1}>
        <Show when={props.loop.ceremony?.stage} fallback={<span style={{ fg: theme.wait }}>not recorded · awaiting migration before ceremony actions</span>}>
          <StageCycle loop={props.loop} />
        </Show>
        <span style={{ fg: theme.dim }}>{"   " + (closedAt() ? "closed " + displayText(closedAt()) : "open") + (props.tail ? " " + GLYPH.separator + " " + props.tail : "")}</span>
      </text>
    </Field>
  );
}

/** The ticket table's columns: steps, ticket, status, seat, PR, CI, tokens. */
const TICKET_WIDTH = { steps: 5, status: 12, seat: 13, pr: 8, work: 5 } as const;
const ticketTitleWidth = (width: number) => { const w = TICKET_WIDTH; return Math.max(10, width - 4 - (w.steps + 1) - 1 - (w.status + 1) - (w.seat + 1) - (w.pr + 1) - w.work); };

/** The sprint section on the team screen: the whole ceremony, one labelled row per part and one row per ticket. */
export function SprintCard(props: { sprint: TerminalSprint; model: TerminalUiModel; team?: StateTeam; session?: TerminalSession; pulse: Accessor<boolean>; now: Accessor<number>; width: Accessor<number>; open?: (url: string) => void; truecolor?: boolean }) {
  const loop = () => props.sprint.loop;
  const stage = () => loop().ceremony?.stage;
  const closedAt = () => loop().ceremony?.closure?.closedAt ?? loop().closedAt;
  const retro = () => publishedRetro(loop()) ?? loop().retro;
  const started = () => loop().ceremony?.history.find((entry) => entry.enteredAt)?.enteredAt ?? props.session?.createdAt;
  const merged = () => loop().tickets.filter((ticket) => ticket.status === "merged").length;
  const seatName = (seatId: string) => displayText(props.team?.seats.find((seat) => seat.id === seatId)?.displayName ?? seatId, 30);
  const integrationUrl = () => loop().integration?.prUrl ?? loop().release?.prUrl;
  const progress = () => sprintProgress({ stage: stage(), closed: !!closedAt(), merged: merged(), tickets: loop().tickets.length });
  const fill = () => closedAt() ? STAGE_COLOR.closed : STAGE_COLOR[stage() ?? "planning"];
  const needsPlan = () => props.sprint.planningStage === "awaiting-review" && stage() === "proposal";
  const title = () => ticketTitleWidth(props.width());
  /** The ticket table needs 90 columns; below that each ticket takes two rows. */
  const wide = () => props.width() >= 90;
  const w = TICKET_WIDTH;
  return (
    <Section title={"SPRINT " + displayText(props.sprint.id, 40)}>
      <StagesField loop={loop()} tail={loop().workflowModel ? "whole-goal ownership" : merged() + "/" + loop().tickets.length + " merged"} />
      <Show when={!loop().workflowModel}>
      <Field label="progress">
        <ProgressBar fraction={progress} color={fill} width={24} truecolor={props.truecolor ?? true} background={theme.background} />
        <text fg={theme.dim} flexShrink={0} wrapMode="none">{String(Math.round(progress() * 100)).padStart(4) + "%"}</text>
      </Field>
      </Show>
      <Field label="tokens">
        <text flexShrink={1} flexGrow={1}>
          <UsageSpans usage={loop().usage} now={props.now} />
          <span style={{ fg: theme.dim }}>{" " + GLYPH.separator + " " + formatElapsed(elapsedSince(started(), closedAt() ? Date.parse(closedAt()!) : props.now())) + " since planning"}</span>
        </text>
      </Field>
      <FieldText label="goal" value={displayText(props.sprint.goal, 180)} />
      <LinkRow links={sprintLinks(props.team, props.session)} open={props.open} />
      <FieldText label="plan" value={proposalDetail(props.sprint)} glyph={needsPlan() ? GLYPH.state.needs : undefined} glyphColor={stateColor("needs", props.pulse())} />
      <Show when={loop().goal}><WorkflowDetail live={{ process: "running", goal: loop().goal }} open={props.open} /></Show>
      <Show when={!loop().workflowModel}>
      <Show when={loop().tickets.length} fallback={<FieldText label="tickets" value="No historical outcomes assigned." color={theme.dim} />}>
        <Show when={wide()}>
          <text fg={theme.dim} flexShrink={0} wrapMode="none">
            {"    " + pad("STEPS", w.steps) + " " + pad("TICKET", title()) + " " + pad("STATUS", w.status) + " " + pad("SEAT", w.seat) + " " + pad("PR", w.pr - 1) + "CI" + padStart("WORK", w.work)}
          </text>
        </Show>
        <For each={loop().tickets}>{(ticket) => {
          const state = ticketState(ticket);
          const steps = pipelineSteps({ status: ticket.status, step: ticket.facts?.step, fixRounds: ticket.facts?.fixRounds });
          const pr = ticket.prUrl ? prText(ticket.prUrl) : "";
          // Narrower than the table: the whole title with its status, then the seat, PR, CI and work under it.
          const narrow = () => (
            <box flexDirection="column" flexShrink={0}>
              <text wrapMode="word" flexShrink={0}>
                <span>{"    "}</span>
                <Pipeline steps={steps} pulse={props.pulse} />
                <span style={{ fg: theme.text }}>{" " + displayText(ticket.title, 400) + " " + GLYPH.separator + " "}</span>
                <span style={{ fg: stateColor(state, props.pulse()) }}>{ticket.status}</span>
              </text>
              <box flexDirection="row" height={1} flexShrink={0}>
                <text flexShrink={0} fg={theme.dim}>{"          " + seatName(ticket.seatId) + " " + GLYPH.separator + " "}</text>
                <LinkText url={ticket.prUrl} label={ticket.prUrl ? pr : "PR not opened"} open={props.open} />
                <text flexShrink={0} wrapMode="none">
                  <span style={{ fg: ticket.facts?.ci ? CI_COLOR[ticket.facts.ci] : theme.dim }}>{ticket.facts?.ci ? " " + GLYPH.ci : ""}</span>
                  <span style={{ fg: theme.dim }}>{" " + GLYPH.separator + " work " + formatTokens(workTokens(ticket.facts?.usage))}</span>
                </text>
              </box>
            </box>
          );
          return (
            <Show when={wide()} fallback={narrow()}>
            <box flexDirection="row" height={1} flexShrink={0}>
              <text flexShrink={0} wrapMode="none">
                <span>{"    "}</span>
                <Pipeline steps={steps} pulse={props.pulse} />
                <span style={{ fg: theme.text }}>{" " + pad(clip(displayText(ticket.title, 400), title()), title()) + " "}</span>
                <span style={{ fg: stateColor(state, props.pulse()) }}>{pad(ticket.status, w.status) + " "}</span>
                <span style={{ fg: theme.dim }}>{pad(clip(seatName(ticket.seatId), w.seat), w.seat) + " "}</span>
              </text>
              <Show when={ticket.prUrl}><LinkText url={ticket.prUrl} label={pr} open={props.open} /></Show>
              <text flexShrink={0} wrapMode="none">
                <span>{" ".repeat(Math.max(1, w.pr - 1 - Array.from(pr).length))}</span>
                <span style={{ fg: ticket.facts?.ci ? CI_COLOR[ticket.facts.ci] : theme.dim }}>{ticket.facts?.ci ? GLYPH.ci : " "}</span>
                <span style={{ fg: theme.text }}>{" " + padStart(formatTokens(workTokens(ticket.facts?.usage)), w.work)}</span>
              </text>
            </box>
            </Show>
          );
        }}</For>
      </Show>
      </Show>
      <Field label="integration">
        <LinkText url={integrationUrl()} label={integrationUrl() ? GLYPH.pr + " " + (prLabel(integrationUrl(), true) ?? displayText(integrationUrl(), 200)) : "not opened"} open={props.open} />
        <Show when={loop().integration?.revertPrUrl}>
          <text fg={theme.dim} flexShrink={0}>{" " + GLYPH.separator + " revert "}</text>
          <LinkText url={loop().integration?.revertPrUrl} label={prText(loop().integration?.revertPrUrl, true)} open={props.open} />
        </Show>
      </Field>
      <FieldText label="release" value={displayText(releaseDetail(loop()), 2000)} glyph={loop().release ? GLYPH.state.done : undefined}
        glyphColor={loop().release ? theme.ok : stateColor("needs", props.pulse())} />
      <Show when={loop().build}><FieldText label="build" value={displayText(loop().build?.reason || buildStatus[loop().build!.status], 2000)} /></Show>
      <FieldText label="retro" value={retroDetail(loop())} glyph={closedAt() ? GLYPH.state.done : undefined}
        glyphColor={closedAt() ? theme.ok : stateColor("needs", props.pulse())} />
      <Show when={retro()?.path || retro()?.prUrl}>
        <Field label="document">
          <Show when={retro()?.path}><text fg={theme.text} flexShrink={0}>{displayText(retro()?.path, 200) + " "}</text></Show>
          <Show when={retro()?.prUrl}><text fg={theme.dim} flexShrink={0}>{GLYPH.separator + " retro PR "}</text><LinkText url={retro()?.prUrl} label={prText(retro()?.prUrl, true)} open={props.open} /></Show>
        </Field>
      </Show>
    </Section>
  );
}

/** The seat screen's short view of a sprint: where the ceremony is and what it waits for. */
export function SprintStrip(props: { sprint: TerminalSprint; team?: StateTeam; session?: TerminalSession; pulse: Accessor<boolean>; open?: (url: string) => void }) {
  const loop = () => props.sprint.loop;
  const detail = (): [string, string] => {
    const current = loop().ceremony?.stage;
    if (!current || current === "planning" || current === "proposal") return ["plan", proposalDetail(props.sprint)];
    if (current === "implement" && loop().workflowModel) return ["goal", loop().goal?.status ?? "progress unavailable"];
    if (current === "implement") return ["tickets", loop().tickets.filter((ticket) => ticket.status === "merged").length + "/" + loop().tickets.length + " tickets merged"];
    if (current === "release") return ["release", releaseDetail(loop())];
    return ["retro", retroDetail(loop())];
  };
  return (
    <Section title={"SPRINT " + displayText(props.sprint.id, 40)}>
      <StagesField loop={loop()} tail={"work " + formatTokens(workTokens(loop().usage))} />
      <FieldText label={detail()[0]} value={displayText(detail()[1], 300)} />
      <LinkRow links={sprintLinks(props.team, props.session)} open={props.open} />
    </Section>
  );
}

/** The labelled pipeline on the seat screen: each stage's glyph and name, lit as it advances. */
export function PipelineLabels(props: { steps: PipelineStep[]; pulse: Accessor<boolean> }) {
  const mark: Partial<Record<StageState, string>> = { failed: " failed", skipped: " skipped" };
  return <text flexShrink={1} flexGrow={1} wrapMode="word">
    <For each={props.steps}>{(step, index) => <>
      <span style={{ fg: theme.dim }}>{index() ? "  " + GLYPH.arrow + "  " : ""}</span>
      <span style={{ fg: stepColor(step.state, props.pulse()) }}>{stepGlyph(step) + " "}</span>
      <span style={{ fg: step.state === "pending" || step.state === "skipped" ? theme.dim : theme.text }}>{step.stage + (mark[step.state] ?? "")}</span>
    </>}</For>
  </text>;
}

export { clip, elapsedText, pad };
