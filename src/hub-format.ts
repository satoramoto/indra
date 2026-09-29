import type { TokenUsage } from "./runtime-facts.js";

/**
 * Pure presentation helpers for the terminal UI hub: pipeline icons, token and time formatting, and link building.
 * Nothing here reads files or the network; the inputs are Indra's recorded facts.
 */

/** An assignment's pipeline, in order. */
export const PIPELINE = ["build", "review", "fix", "ci", "merge"] as const;
export type PipelineStage = typeof PIPELINE[number];
export const PIPELINE_ICON: Record<PipelineStage, string> = { build: "🔨", review: "🔍", fix: "🩹", ci: "🧪", merge: "🔀" };
/** `skipped` is a fix round that was never needed; `failed` is where a failed assignment stopped. */
export type StageState = "done" | "active" | "pending" | "skipped" | "failed";
export interface PipelineStep { stage: PipelineStage; state: StageState }

/** The steps a Developer seat records (`SeatTaskRecord.step`). */
export type SeatStep = "worktree" | "build" | "review" | "fix" | "ci" | "done";
/** Assignment status in state, or the sprint ticket's projection of it. */
export type AssignmentStatus = "queued" | "running" | "in-review" | "building" | "in review" | "merged" | "failed" | "not assigned";

const stepStage: Record<SeatStep, PipelineStage> = { worktree: "build", build: "build", review: "review", fix: "fix", ci: "ci", done: "merge" };

/**
 * Lights the pipeline for one assignment. The seat's recorded step is exact; without it the assignment status gives
 * the stage (running is building, in review is reviewing). A fix that never ran before a later stage shows skipped.
 */
export function pipelineSteps(input: { status: string; step?: string; fixRounds?: number }): PipelineStep[] {
  const status = input.status as AssignmentStatus;
  if (status === "merged") return PIPELINE.map((stage) => ({ stage, state: stage === "fix" && !input.fixRounds && input.step !== undefined ? "skipped" : "done" }));
  const recorded = input.step && input.step in stepStage ? stepStage[input.step as SeatStep] : undefined;
  const current = recorded ?? (status === "running" || status === "building" ? "build" : status === "in-review" || status === "in review" ? "review" : undefined);
  if (!current) return PIPELINE.map((stage) => ({ stage, state: status === "failed" && stage === "build" ? "failed" : "pending" }));
  const at = PIPELINE.indexOf(current);
  return PIPELINE.map((stage, index) => {
    if (index < at) return { stage, state: stage === "fix" && !input.fixRounds ? "skipped" : "done" };
    if (index === at) return { stage, state: status === "failed" ? "failed" : "active" };
    return { stage, state: "pending" };
  });
}

/** CI as recorded in the implementation ledger: the newest CI event of the newest attempt. */
export type CiState = "passed" | "pending" | "failed";
export const CI_DOT: Record<CiState, string> = { passed: "🟢", pending: "🟡", failed: "🔴" };

/** 950 · 12.3k · 1.25M · 3.1B; unknown counters show as an en dash. */
export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "–";
  if (value < 1000) return String(Math.round(value));
  const [scale, unit] = value >= 1e9 ? [1e9, "B"] : value >= 1e6 ? [1e6, "M"] : [1e3, "k"];
  const scaled = value / scale;
  const text = scaled >= 100 ? Math.round(scaled).toString() : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
  return (text.includes(".") ? text.replace(/\.?0+$/, "") : text) + unit;
}

const counter = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const USAGE_KEYS = ["inputTokens", "uncachedInputTokens", "cachedInputTokens", "cacheWriteInputTokens", "outputTokens", "reasoningOutputTokens"] as const;

/** Recorded usage is typed `unknown` in older records; only numeric counters are kept. */
export function parseUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result: TokenUsage = {};
  for (const key of USAGE_KEYS) { const count = counter(record[key]); if (count !== undefined) result[key] = count; }
  return Object.keys(result).length ? result : undefined;
}

/** Sums counters; a counter missing from every report stays unknown. */
export function sumUsage(reports: (TokenUsage | undefined)[]): TokenUsage | undefined {
  const result: TokenUsage = {};
  for (const report of reports) for (const key of USAGE_KEYS) {
    const count = counter(report?.[key]);
    if (count !== undefined) result[key] = (result[key] ?? 0) + count;
  }
  return Object.keys(result).length ? result : undefined;
}

/** The running cost in tokens: all input (cached included) plus output. */
export function totalTokens(usage: TokenUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const input = usage.inputTokens ?? (usage.uncachedInputTokens !== undefined ? usage.uncachedInputTokens + (usage.cachedInputTokens ?? 0) + (usage.cacheWriteInputTokens ?? 0) : undefined);
  if (input === undefined && usage.outputTokens === undefined) return undefined;
  return (input ?? 0) + (usage.outputTokens ?? 0);
}

/** `in 1.2M · cached 980k · out 45k · Σ 1.25M tok`, the same shape for a seat and a sprint. */
export function usageLine(usage: TokenUsage | undefined): string {
  if (!usage) return "no tokens recorded yet";
  return `in ${formatTokens(usage.inputTokens)} · cached ${formatTokens(usage.cachedInputTokens)} · out ${formatTokens(usage.outputTokens)} · Σ ${formatTokens(totalTokens(usage))} tok`;
}

/** 45s · 12m · 2h05m · 3d04h. */
export function formatElapsed(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "–";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h" + String(minutes % 60).padStart(2, "0") + "m";
  return Math.floor(hours / 24) + "d" + String(hours % 24).padStart(2, "0") + "h";
}

/** Milliseconds from an ISO time to `now`; undefined for an unreadable time. */
export function elapsedSince(iso: string | undefined, now: number): number | undefined {
  const start = Date.parse(iso ?? "");
  return Number.isFinite(start) && now >= start ? now - start : undefined;
}

/** Indra's Mattermost server; the planning bridge and inventory talk to the same one. */
export const MATTERMOST_SERVER = "https://mattermost.newegypt.io";
const MATTERMOST_ID = /^[a-z0-9]{26}$/;
const TEAM_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** A post permalink, `<server>/<team>/pl/<post>`; undefined unless both come from state in their recorded shape. */
export function mattermostPostUrl(teamSlug: string | undefined, postId: string | undefined, server = MATTERMOST_SERVER): string | undefined {
  return teamSlug && postId && TEAM_NAME.test(teamSlug) && MATTERMOST_ID.test(postId) ? `${server}/${teamSlug}/pl/${postId}` : undefined;
}

/** A channel link, `<server>/<team>/channels/<channel>`. */
export function mattermostChannelUrl(teamSlug: string | undefined, channelId: string | undefined, server = MATTERMOST_SERVER): string | undefined {
  return teamSlug && channelId && TEAM_NAME.test(teamSlug) && MATTERMOST_ID.test(channelId) ? `${server}/${teamSlug}/channels/${channelId}` : undefined;
}

const GITHUB_PR = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;

/** `#123`, or `owner/repo#123` with `repo`; undefined for anything that is not a GitHub PR URL. */
export function prLabel(url: string | undefined, repo = false): string | undefined {
  const match = GITHUB_PR.exec(url ?? "");
  if (!match) return undefined;
  return (repo ? `${match[1]}/${match[2]}` : "") + "#" + match[3];
}

/** Only links Indra builds itself are opened: GitHub PRs and Mattermost pages on Indra's server. */
export function openableUrl(url: string | undefined, server = MATTERMOST_SERVER): string | undefined {
  if (!url) return undefined;
  if (GITHUB_PR.test(url)) return url;
  return url.startsWith(server + "/") && /^[\w/.-]+$/.test(url.slice(server.length)) ? url : undefined;
}
