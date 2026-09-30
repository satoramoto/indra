/** Shared contracts for the goal workflow. This module owns no processes, storage or lane behavior. */
export const WORKFLOW_MODEL = "goals-v1" as const;
export const GOAL_REVIEWER = "independent-agent" as const;
export type GoalReviewer = typeof GOAL_REVIEWER | "satori-miyamoto";
export const isGoalReviewer = (value: unknown): value is GoalReviewer => value === GOAL_REVIEWER || value === "satori-miyamoto";

export class GoalContractError extends Error {
  override name = "GoalContractError";
}

export interface GoalOutcome {
  number: number;
  title: string;
  description: string;
  reason: string;
  currentCode: string[];
}

export interface GoalRetrospective { goalId: string; path: string; summary: string }
export interface GoalRedirect { postId: string; userId: string; at: string; message: string }

export interface GoalBrief {
  version: 1;
  goalId: string;
  teamId: string;
  seatId: string;
  header: { repo: string; baseBranch: string; baseSha: string; branch: string; prTarget: string };
  outcomes: GoalOutcome[];
  ownedFiles: string[];
  exclusions: { files: string[]; owner: string; reason: string }[];
  swarm: string;
  retros: GoalRetrospective[];
  redirects: GoalRedirect[];
  reportFormat: string;
}

export interface GoalLaneReport {
  laneId: string;
  url: string;
  headSha: string;
  mergedSha: string;
  reviewer: GoalReviewer;
  ci: "passed";
}

export interface GoalReport {
  version: 1;
  goalId: string;
  teamId: string;
  seatId: string;
  sprintBranch: string;
  headSha: string;
  lanePrs: GoalLaneReport[];
  checks: { command: string; exitCode: number }[];
  decisions: string[];
  followUps: string[];
  neededButUnowned: string[];
}

export interface GoalLane {
  id: string;
  branch: string;
  ownedFiles: string[];
  dependsOn: string[];
}

export interface LanePlan {
  version: 1;
  goalId: string;
  lanes: GoalLane[];
  contractLaneId: string | null;
}

export interface ProductProposal {
  version: 1;
  goalId: string;
  proposalId: string;
  productSeatId: string;
  rank: number;
  mission: string;
  summary: string;
  outcomes: GoalOutcome[];
  ownedFiles: string[];
  risks: string[];
  rationale: string;
  basedOnRetros: string[];
}

type ObjectValue = Record<string, unknown>;
function fail(message: string): never { throw new GoalContractError(message); }
function object(value: unknown, keys: readonly string[], label: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  const result = value as ObjectValue;
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)) || Object.keys(result).some((key) => !keys.includes(key))) {
    fail(`${label} must contain exactly its documented fields.`);
  }
  return result;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) fail(`${label} must be nonempty text.`);
  return value;
}
function identifier(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[a-z][a-z0-9-]*$/.test(result)) fail(`${label} must be a lowercase identifier.`);
  return result;
}
function sha(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{40}$/.test(result)) fail(`${label} must be a full lowercase commit SHA.`);
  return result;
}
function integer(value: unknown, label: string, minimum?: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || (minimum !== undefined && value < minimum)) fail(`${label} must be a valid integer.`);
  return value;
}
function array(value: unknown, label: string, minimum = 0, maximum = Infinity): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} has an invalid number of entries.`);
  return value;
}
function texts(value: unknown, label: string, minimum = 0): string[] {
  return array(value, label, minimum).map((item) => text(item, label));
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) fail(`${label} must not contain duplicates.`);
}
function version(value: unknown): 1 {
  if (value !== 1) fail("Unsupported goal contract version.");
  return 1;
}
function time(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) fail(`${label} must be an ISO timestamp with a timezone.`);
  return result;
}
function branch(value: unknown, label: string): string {
  const result = text(value, label);
  if (result === "@" || result.startsWith("-") || result.startsWith("/") || result.endsWith("/") || result.endsWith(".") || result.includes("..") || result.includes("@{") || /[\s\u0000-\u001f\u007f~^:?*\[\\]/u.test(result)
    || result.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) fail(`${label} must be a safe Git branch name.`);
  return result;
}
function localBranch(value: string): string {
  return value.replace(/^refs\/remotes\/origin\//, "").replace(/^refs\/heads\//, "").replace(/^origin\//, "");
}
function prUrl(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^https:\/\/github\.com\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/(?!\.{1,2}\/)[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(result)) fail(`${label} must be a GitHub pull request URL without credentials or query parameters.`);
  return result;
}
function outcomes(value: unknown): GoalOutcome[] {
  return array(value, "Outcomes", 1).map((item, index) => {
    const row = object(item, ["number", "title", "description", "reason", "currentCode"], "Outcome");
    const number = integer(row.number, "Outcome number", 1);
    if (number !== index + 1) fail("Outcomes must be numbered consecutively from one.");
    return { number, title: text(row.title, "Outcome title"), description: text(row.description, "Outcome description"), reason: text(row.reason, "Outcome reason"), currentCode: texts(row.currentCode, "Current-code references") };
  });
}

/** POSIX repository paths; the supported glob syntax is *, ?, and ** as a complete segment. */
function filePath(value: unknown, pattern: boolean): string {
  const result = text(value, pattern ? "Owned file pattern" : "Repository file");
  if (result.length > 512 || result !== result.trim() || result.startsWith("/") || /^[A-Za-z]:/.test(result) || /[\\\u0000-\u001f\u007f]/u.test(result)) fail("File boundaries require safe relative repository paths.");
  const segments = result.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) fail("File boundaries cannot contain empty or traversal segments.");
  if (pattern && (/[\[\]{}!]/.test(result) || segments.some((segment) => segment.includes("**") && segment !== "**"))) fail("Unsupported owned-files glob; use literals, *, ?, or a whole ** segment.");
  if (!pattern && /[*?]/.test(result)) fail("A repository file must be a literal path.");
  return result;
}

function patternSegments(pattern: string): string[] {
  return pattern.split("/").filter((segment, index, segments) => segment !== "**" || segments[index - 1] !== "**");
}

export function validateOwnedFiles(value: unknown): string[] {
  const result = array(value, "Owned files", 1, 128).map((item) => filePath(item, true));
  unique(result.map((item) => patternSegments(item).join("/")), "Owned files");
  return result;
}

interface Edge { to: number; character: string | null }
interface AutomatonNode { epsilon: number[]; edges: Edge[] }
interface Automaton { nodes: AutomatonNode[]; accepting: Set<number> }

/** A null transition consumes one character other than /. No filesystem expansion is involved. */
function compilePatterns(patterns: readonly string[]): Automaton {
  const nodes: AutomatonNode[] = [{ epsilon: [], edges: [] }];
  const accepting = new Set<number>();
  const node = (): number => { nodes.push({ epsilon: [], edges: [] }); return nodes.length - 1; };
  const consume = (from: number, character: string | null): number => {
    const to = node(); nodes[from].edges.push({ to, character }); return to;
  };
  const segment = (from: number): number => {
    const end = consume(from, null); nodes[end].edges.push({ to: end, character: null }); return end;
  };
  const repeat = (from: number, content: (start: number) => number): number => {
    const after = node(); nodes[from].epsilon.push(after);
    nodes[content(from)].epsilon.push(from);
    return after;
  };
  for (const pattern of patterns) {
    let current = node(); nodes[0].epsilon.push(current);
    const segments = patternSegments(pattern);
    for (let index = 0; index < segments.length; index += 1) {
      const part = segments[index];
      if (part === "**") {
        if (segments.length === 1) {
          current = segment(current);
          current = repeat(current, (start) => segment(consume(start, "/")));
        } else if (index === segments.length - 1) {
          current = repeat(current, (start) => segment(consume(start, "/")));
        } else {
          if (index > 0) current = consume(current, "/");
          current = repeat(current, (start) => consume(segment(start), "/"));
        }
      } else {
        if (index > 0 && segments[index - 1] !== "**") current = consume(current, "/");
        for (const character of part) {
          if (character === "*") nodes[current].edges.push({ to: current, character: null });
          else current = consume(current, character === "?" ? null : character);
        }
      }
    }
    accepting.add(current);
  }
  return { nodes, accepting };
}

function closure(machine: Automaton, states: readonly number[]): number[] {
  const seen = new Set(states); const remaining = [...states];
  for (let index = 0; index < remaining.length; index += 1) {
    for (const next of machine.nodes[remaining[index]].epsilon) if (!seen.has(next)) { seen.add(next); remaining.push(next); }
  }
  return [...seen].sort((a, b) => a - b);
}
function step(machine: Automaton, states: readonly number[], character: string): number[] {
  const next = new Set<number>();
  for (const state of states) for (const edge of machine.nodes[state].edges) {
    if (edge.character === character || (edge.character === null && character !== "/")) next.add(edge.to);
  }
  return closure(machine, [...next]);
}
function accepts(machine: Automaton, states: readonly number[]): boolean { return states.some((state) => machine.accepting.has(state)); }

/** Exclude empty, . and .. segments when comparing glob languages. State 3 ends a valid filename. */
function pathState(state: number, character: string): number {
  if (character === "/") return state === 3 ? 0 : -1;
  if (character === ".") return state === 0 ? 1 : state === 1 ? 2 : 3;
  return 3;
}

/**
 * Returns whether a future valid path witnesses an intersection or a containment violation.
 * Only literal characters, slash, dot and one representative wildcard character are needed.
 * A bounded search returns unknown on excessive complexity; callers fail closed.
 */
function witness(left: Automaton, right: Automaton, comparison: "intersection" | "outside"): boolean | undefined {
  const alphabet = new Set<string>(["/", "."]);
  for (const machine of [left, right]) for (const entry of machine.nodes) for (const edge of entry.edges) if (edge.character !== null) alphabet.add(edge.character);
  let other = 0xe000;
  while (alphabet.has(String.fromCodePoint(other))) other += 1;
  alphabet.add(String.fromCodePoint(other));
  const pending = [{ left: closure(left, [0]), right: closure(right, [0]), path: 0 }];
  const visited = new Set<string>();
  let transitions = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const current = pending[index];
    if (current.path === 3 && accepts(left, current.left) && (comparison === "intersection" ? accepts(right, current.right) : !accepts(right, current.right))) return true;
    for (const character of alphabet) {
      if (++transitions > 250_000) return undefined;
      const path = pathState(current.path, character);
      if (path < 0) continue;
      const nextLeft = step(left, current.left, character);
      if (!nextLeft.length) continue;
      const nextRight = step(right, current.right, character);
      if (comparison === "intersection" && !nextRight.length) continue;
      const key = `${path}:${nextLeft.join(",")}:${nextRight.join(",")}`;
      if (visited.has(key)) continue;
      visited.add(key);
      if (visited.size > 20_000) return undefined;
      pending.push({ left: nextLeft, right: nextRight, path });
    }
  }
  return false;
}

export function ownedFileMatches(pattern: string, file: string): boolean {
  const machine = compilePatterns([filePath(pattern, true)]);
  let states = closure(machine, [0]);
  for (const character of filePath(file, false)) {
    states = step(machine, states, character);
    if (!states.length) return false;
  }
  return accepts(machine, states);
}

export function ownedFilesOverlap(left: readonly string[], right: readonly string[]): boolean {
  const result = witness(compilePatterns(validateOwnedFiles(left)), compilePatterns(validateOwnedFiles(right)), "intersection");
  return result !== false;
}

export function assertOwnedFilesWithin(child: readonly string[], approved: readonly string[]): void {
  const result = witness(compilePatterns(validateOwnedFiles(child)), compilePatterns(validateOwnedFiles(approved)), "outside");
  if (result !== false) fail(result === undefined ? "Could not prove that the requested files stay within approved ownership." : "Requested files extend beyond approved ownership.");
}

export interface OwnedFileScope { id: string; ownedFiles: readonly string[] }
export function assertDisjointOwnedFiles(scopes: readonly (OwnedFileScope | readonly string[])[]): void {
  if (!Array.isArray(scopes)) fail("File scopes must be an array.");
  const files = scopes.map((scope) => validateOwnedFiles(Array.isArray(scope) ? scope : (scope as OwnedFileScope).ownedFiles));
  for (let left = 0; left < files.length; left += 1) for (let right = left + 1; right < files.length; right += 1) {
    if (ownedFilesOverlap(files[left], files[right])) fail("File owners must have disjoint scopes, including future filenames.");
  }
}

export function validateGoalBrief(value: unknown): GoalBrief {
  const input = object(value, ["version", "goalId", "teamId", "seatId", "header", "outcomes", "ownedFiles", "exclusions", "swarm", "retros", "redirects", "reportFormat"], "Goal brief");
  const goalId = identifier(input.goalId, "Goal ID");
  const sourceHeader = object(input.header, ["repo", "baseBranch", "baseSha", "branch", "prTarget"], "Brief header");
  const header = {
    repo: text(sourceHeader.repo, "Repository"), baseBranch: branch(sourceHeader.baseBranch, "Base branch"), baseSha: sha(sourceHeader.baseSha, "Base commit"),
    branch: branch(sourceHeader.branch, "Work branch"), prTarget: branch(sourceHeader.prTarget, "PR target"),
  };
  const sprint = `sprint/${goalId}`;
  const work = localBranch(header.branch); const base = localBranch(header.baseBranch); const target = localBranch(header.prTarget);
  const goalHeader = work === sprint && target === "main";
  const laneHeader = base === sprint && target === sprint && work !== "main" && work !== sprint && !work.startsWith("sprint/");
  if (!goalHeader && !laneHeader) fail("The brief must describe this goal's sprint targeting main, or a separate lane targeting this goal's sprint.");
  const ownedFiles = validateOwnedFiles(input.ownedFiles);
  const exclusions = array(input.exclusions, "Exclusions").map((item) => {
    const row = object(item, ["files", "owner", "reason"], "Exclusion");
    const files = validateOwnedFiles(row.files);
    if (ownedFilesOverlap(ownedFiles, files)) fail("Excluded files cannot overlap this brief's ownership.");
    return { files, owner: text(row.owner, "Exclusion owner"), reason: text(row.reason, "Exclusion reason") };
  });
  const retros = array(input.retros, "Recent retrospectives", 0, 3).map((item) => {
    const row = object(item, ["goalId", "path", "summary"], "Retrospective");
    const retroGoal = identifier(row.goalId, "Retrospective goal ID");
    const path = filePath(row.path, false);
    if (path !== `docs/retros/${retroGoal}.md`) fail("A retrospective path must identify its own goal document.");
    return { goalId: retroGoal, path, summary: text(row.summary, "Retrospective summary") };
  });
  unique(retros.map((retro) => retro.goalId), "Recent retrospectives");
  const redirects = array(input.redirects, "Redirects").map((item) => {
    const row = object(item, ["postId", "userId", "at", "message"], "Redirect");
    return { postId: text(row.postId, "Redirect post ID"), userId: text(row.userId, "Redirect user ID"), at: time(row.at, "Redirect timestamp"), message: text(row.message, "Redirect message") };
  });
  unique(redirects.map((redirect) => redirect.postId), "Redirect posts");
  return { version: version(input.version), goalId, teamId: identifier(input.teamId, "Team ID"), seatId: identifier(input.seatId, "Seat ID"), header,
    outcomes: outcomes(input.outcomes), ownedFiles, exclusions, swarm: text(input.swarm, "Swarm instruction"), retros, redirects, reportFormat: text(input.reportFormat, "Report format") };
}

export function validateGoalReport(value: unknown): GoalReport {
  const input = object(value, ["version", "goalId", "teamId", "seatId", "sprintBranch", "headSha", "lanePrs", "checks", "decisions", "followUps", "neededButUnowned"], "Goal report");
  const goalId = identifier(input.goalId, "Goal ID");
  const sprintBranch = branch(input.sprintBranch, "Sprint branch");
  if (sprintBranch !== `sprint/${goalId}`) fail("The report must identify this goal's sprint branch.");
  const lanePrs = array(input.lanePrs, "Lane PRs", 1).map((item): GoalLaneReport => {
    const row = object(item, ["laneId", "url", "headSha", "mergedSha", "reviewer", "ci"], "Lane PR");
    if (!isGoalReviewer(row.reviewer) || row.ci !== "passed") fail("Every reported lane requires independent review approval and passing CI.");
    return { laneId: identifier(row.laneId, "Lane ID"), url: prUrl(row.url, "Lane PR URL"), headSha: sha(row.headSha, "Lane head"), mergedSha: sha(row.mergedSha, "Lane merge commit"), reviewer: row.reviewer as GoalReviewer, ci: "passed" };
  });
  unique(lanePrs.map((lane) => lane.laneId), "Reported lanes");
  unique(lanePrs.map((lane) => lane.url), "Reported PRs");
  if (new Set(lanePrs.map((lane) => lane.url.split("/").slice(0, 5).join("/"))).size !== 1) fail("All reported lane PRs must belong to one project.");
  const checks = array(input.checks, "Reported checks", 1).map((item) => {
    const row = object(item, ["command", "exitCode"], "Reported check");
    return { command: text(row.command, "Check command"), exitCode: integer(row.exitCode, "Check exit code") };
  });
  const neededButUnowned = array(input.neededButUnowned, "Needed but unowned files").map((item) => filePath(item, true));
  unique(neededButUnowned, "Needed but unowned files");
  return { version: version(input.version), goalId, teamId: identifier(input.teamId, "Team ID"), seatId: identifier(input.seatId, "Seat ID"), sprintBranch,
    headSha: sha(input.headSha, "Sprint head"), lanePrs, checks, decisions: texts(input.decisions, "Decisions"), followUps: texts(input.followUps, "Follow-ups"), neededButUnowned };
}

export function validateLanePlan(value: unknown, approvedOwnedFiles?: readonly string[]): LanePlan {
  const input = object(value, ["version", "goalId", "lanes", "contractLaneId"], "Lane plan");
  const goalId = identifier(input.goalId, "Goal ID");
  const lanes = array(input.lanes, "Lanes", 1, 128).map((item): GoalLane => {
    const row = object(item, ["id", "branch", "ownedFiles", "dependsOn"], "Lane");
    const id = identifier(row.id, "Lane ID");
    const laneBranch = branch(row.branch, "Lane branch");
    const local = localBranch(laneBranch);
    if (local === "main" || local.startsWith("sprint/")) fail("A lane needs its own branch, separate from main and sprint branches.");
    const dependsOn = array(row.dependsOn, "Lane dependencies").map((dependency) => identifier(dependency, "Dependency lane ID"));
    unique(dependsOn, "Lane dependencies");
    if (dependsOn.includes(id)) fail("A lane cannot depend on itself.");
    return { id, branch: laneBranch, ownedFiles: validateOwnedFiles(row.ownedFiles), dependsOn };
  });
  unique(lanes.map((lane) => lane.id), "Lanes");
  unique(lanes.map((lane) => localBranch(lane.branch)), "Lane branches");
  const byId = new Map(lanes.map((lane) => [lane.id, lane]));
  for (const lane of lanes) if (lane.dependsOn.some((id) => !byId.has(id))) fail("A lane dependency names an unknown lane.");
  const active = new Set<string>(); const complete = new Set<string>();
  const visit = (id: string): void => {
    if (active.has(id)) fail("Lane dependencies must not contain a cycle.");
    if (complete.has(id)) return;
    active.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
    active.delete(id); complete.add(id);
  };
  for (const lane of lanes) visit(lane.id);
  const contractLaneId = input.contractLaneId === null ? null : identifier(input.contractLaneId, "Contract lane ID");
  if (contractLaneId !== null) {
    const contract = byId.get(contractLaneId);
    if (!contract || contract.dependsOn.length) fail("The declared contract must be a lane with no dependencies.");
    const follows = new Map<string, boolean>([[contractLaneId, true]]);
    const followsContract = (id: string): boolean => {
      const known = follows.get(id);
      if (known !== undefined) return known;
      const result = byId.get(id)!.dependsOn.some(followsContract);
      follows.set(id, result);
      return result;
    };
    if (lanes.some((lane) => !followsContract(lane.id))) fail("Every other lane must follow the declared contract lane.");
  }
  assertDisjointOwnedFiles(lanes);
  if (approvedOwnedFiles) for (const lane of lanes) assertOwnedFilesWithin(lane.ownedFiles, approvedOwnedFiles);
  return { version: version(input.version), goalId, lanes, contractLaneId };
}

export function validateProductProposal(value: unknown): ProductProposal {
  const input = object(value, ["version", "goalId", "proposalId", "productSeatId", "rank", "mission", "summary", "outcomes", "ownedFiles", "risks", "rationale", "basedOnRetros"], "Product proposal");
  const basedOnRetros = texts(input.basedOnRetros, "Retrospective references");
  unique(basedOnRetros, "Retrospective references");
  return { version: version(input.version), goalId: identifier(input.goalId, "Goal ID"), proposalId: identifier(input.proposalId, "Proposal ID"), productSeatId: identifier(input.productSeatId, "Product seat ID"),
    rank: integer(input.rank, "Proposal rank", 1), mission: text(input.mission, "Mission"), summary: text(input.summary, "Proposal summary"), outcomes: outcomes(input.outcomes),
    ownedFiles: validateOwnedFiles(input.ownedFiles), risks: texts(input.risks, "Risks"), rationale: text(input.rationale, "Proposal rationale"), basedOnRetros };
}

/** The durable assignment is for one goal and one Developer; lane and session details remain in runtime. */
export interface GoalAssignment {
  seatId: string;
  status: "assigned" | "running" | "reported" | "failed";
  updatedAt: string;
}

export type GoalLaneStatus = "queued" | "running" | "pr-open" | "reviewing" | "changes-requested" | "merging" | "merged" | "failed";
export interface GoalReviewFinding { path: string; line: number; reason: string }
export interface GoalLaneProgress extends GoalLane {
  status: GoalLaneStatus;
  prUrl: string | null;
  headSha: string | null;
  mergedSha: string | null;
  reviewer: string | null;
  review: "pending" | "approved" | "changes-requested" | "dismissed";
  ci: "pending" | "passed" | "failed";
  findings: GoalReviewFinding[];
  fixRounds: number;
  conflictRounds: number;
  decisions: string[];
  followUps: string[];
  updatedAt: string;
}
export type LaneProgress = GoalLaneProgress;

interface WorkflowEventBase { id: string; teamId: string; at: string }
/** Hosts deliver events; services do not sleep, poll, or hold a goal context between turns. */
export type WorkflowEvent = { kind: "startup"; teamId: string; at: string } | WorkflowEventBase & (
  | { kind: "proposal"; goalId: string; proposalId: string }
  | { kind: "approval"; goalId: string }
  | { kind: "proposal-vetted"; goalId: string; vetting: ProductProposalVetting }
  | { kind: "developer-report"; goalId: string; seatId: string; report: GoalReport }
  | { kind: "ci"; goalId: string; laneId: string | null; prUrl: string; headSha: string; state: "pending" | "passed" | "failed" }
  | { kind: "review"; goalId: string; laneId: string | null; prUrl: string; headSha: string; reviewer: string; state: "approved" | "changes-requested" | "dismissed"; findings: GoalReviewFinding[] }
  | { kind: "merge"; goalId: string; laneId: string | null; prUrl: string; headSha: string; mergedSha: string }
  | { kind: "build-running"; goalId: string; buildSha: string; runningSha: string }
  | { kind: "redirect"; goalId: string | null; redirect: GoalRedirect }
  | { kind: "goal-closed"; goalId: string }
  | { kind: "seat-idle"; seatId: string }
  | { kind: "retry"; goalId: string; reason: string }
  | { kind: "product-retry"; seatId: string; reason: string }
  | { kind: "queue-changed" }
  | { kind: "conflict"; goalId: string; laneId: string; prUrl: string; headSha: string; baseSha: string }
  | { kind: "agent-completed"; goalId: string; laneId: string; agentId: string; status: "succeeded" | "failed"; headSha: string | null; report: GoalReport | null }
);

export interface WorkflowFailure { at: string; message: string; retryable: boolean }
export interface GoalRuntimeRecord {
  version: 1;
  goalId: string;
  teamId: string;
  assignment: GoalAssignment | null;
  brief: GoalBrief | null;
  plan: LanePlan | null;
  lanes: GoalLaneProgress[];
  report: GoalReport | null;
  events: WorkflowEvent[];
  handledEventIds: string[];
  redirects: GoalRedirect[];
  failure: WorkflowFailure | null;
  updatedAt: string;
}

export interface ProductProposalVetting { proposalId: string; leadSeatId: string; ownedFiles: string[]; notes: string[]; at: string }
export interface ProductQueueEntry {
  proposal: ProductProposal;
  vetting: ProductProposalVetting | null;
  status: "proposed" | "posted" | "approved";
  rootPostId: string | null;
  proposalPostId: string | null;
}
export interface ProductRuntimeRecord {
  version: 1;
  teamId: string;
  seatId: string;
  /** At most five unapproved proposals; approved goals belong in the scheduler queue. */
  queue: ProductQueueEntry[];
  events: WorkflowEvent[];
  handledEventIds: string[];
  pending: { goalId: string; proposalId: string; deliveryId: string; message: string } | null;
  failure: WorkflowFailure | null;
  updatedAt: string;
}

/** Count one shared unapproved queue across unpublished candidates and actual published goals. */
export function assertProductQueueCapacity(record: ProductRuntimeRecord, publishedUnapproved: readonly { goalId: string; proposalId: string }[]): void {
  const pending = record.queue.filter((entry) => entry.status !== "approved");
  unique(pending.map((entry) => entry.proposal.goalId), "Product queue goal IDs");
  if (publishedUnapproved.length > 1) fail("Only one published Product proposal may await approval per team.");
  const total = new Set([...pending.map((entry) => entry.proposal.goalId), ...publishedUnapproved.map((goal) => goal.goalId)]);
  if (total.size > 5) fail("Product's unapproved queue is capped at five including published proposals.");
  if (pending.filter((entry) => entry.status === "posted").length > 1) fail("Only one Product proposal may be posted at a time.");
  for (const goal of publishedUnapproved) {
    const candidate = pending.find((entry) => entry.proposal.goalId === goal.goalId);
    if (candidate && candidate.proposal.proposalId !== goal.proposalId) fail("Published proposal identity differs from its queued candidate.");
  }
}

export interface GoalDispatch {
  goalId: string;
  seatId: string;
  status: "assigned" | "running" | "reported" | "releasing" | "retro";
  assignedAt: string;
  brief: GoalBrief;
}
export interface SchedulerRuntimeRecord {
  version: 1;
  teamId: string;
  events: WorkflowEvent[];
  handledEventIds: string[];
  redirects: GoalRedirect[];
  activeDispatches: GoalDispatch[];
  approvedQueue: { goalId: string; rank: number; ownedFiles: string[]; blockedByGoalIds: string[] }[];
  failure: WorkflowFailure | null;
  updatedAt: string;
}

export function goalRuntimeFilename(goalId: string): string { return `goal-workflow-${identifier(goalId, "Goal ID")}`; }
export function teamRuntimeFilename(teamId: string): string { return `team-workflow-${identifier(teamId, "Team ID")}`; }
export function productRuntimeFilename(teamId: string): string { return `product-workflow-${identifier(teamId, "Team ID")}`; }

export interface GoalRuntimeProjection {
  goalId: string;
  teamId: string;
  seatId: string | null;
  status: GoalAssignment["status"] | "unassigned";
  summary: string;
  ownedFiles: string[];
  lanes: { id: string; branch: string; ownedFiles: string[]; status: GoalLaneStatus; prUrl: string | null; headSha: string | null; mergedSha: string | null; ci: GoalLaneProgress["ci"]; review: GoalLaneProgress["review"] }[];
  headSha: string | null;
  decisions: string[];
  followUps: string[];
  neededButUnowned: string[];
  failure: WorkflowFailure | null;
}

/** Detached UI data; a view cannot mutate the service's runtime journal through this projection. */
export function projectGoalRuntime(record: GoalRuntimeRecord): GoalRuntimeProjection {
  return {
    goalId: record.goalId, teamId: record.teamId, seatId: record.assignment?.seatId ?? record.brief?.seatId ?? record.report?.seatId ?? null,
    status: record.failure ? "failed" : record.assignment?.status ?? "unassigned",
    summary: record.brief?.outcomes.map((outcome) => outcome.title).join("; ") ?? "",
    ownedFiles: [...(record.brief?.ownedFiles ?? [])],
    lanes: record.lanes.map((lane) => ({ id: lane.id, branch: lane.branch, ownedFiles: [...lane.ownedFiles], status: lane.status, prUrl: lane.prUrl, headSha: lane.headSha, mergedSha: lane.mergedSha, ci: lane.ci, review: lane.review })),
    headSha: record.report?.headSha ?? null,
    decisions: [...(record.report?.decisions ?? record.lanes.flatMap((lane) => lane.decisions))],
    followUps: [...(record.report?.followUps ?? record.lanes.flatMap((lane) => lane.followUps))],
    neededButUnowned: [...(record.report?.neededButUnowned ?? [])], failure: record.failure ? { ...record.failure } : null,
  };
}

/** Each call consumes one event and returns; implementations receive state explicitly, never an immortal session. */
export interface DeveloperTurnService {
  runTurn(context: { event: WorkflowEvent; brief: GoalBrief; record: GoalRuntimeRecord }): Promise<{ record: GoalRuntimeRecord; events: WorkflowEvent[]; report: GoalReport | null }>;
}
export interface ProductTurnService {
  runTurn(context: { event: WorkflowEvent; mission: string; retros: GoalRetrospective[]; record: ProductRuntimeRecord }): Promise<{ record: ProductRuntimeRecord; proposals: ProductProposal[]; events: WorkflowEvent[] }>;
}
export interface SchedulerTurnService {
  runTurn(context: { event: WorkflowEvent; record: SchedulerRuntimeRecord }): Promise<{ record: SchedulerRuntimeRecord; events: WorkflowEvent[]; dispatches: GoalDispatch[] }>;
}
