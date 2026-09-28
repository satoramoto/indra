import type { StateSnapshot, StateTeam } from "./state-domain.js";

/** One active account in a live chat team, as the consistency check needs it. */
export interface LiveMember {
  userId: string;
  username: string;
  position: string;
  isBot: boolean;
}

/** Read-only port: the active accounts that belong to a chat team. */
export interface TeamMemberReader {
  listTeamMembers(teamId: string): Promise<LiveMember[]>;
}

export type MismatchKind = "missing" | "username" | "position" | "unexpected";

export interface Mismatch {
  kind: MismatchKind;
  teamId: string;
  /** The state seat the mismatch concerns; absent for an account that no seat claims. */
  seatId?: string;
  field: string;
  message: string;
}

export interface TeamReport {
  team: StateTeam;
  mismatches: Mismatch[];
  /** Human accounts in the team that no seat claims. Informational only; never a mismatch. */
  unclaimedHumans: LiveMember[];
}

/** Compares one state team with its live members. Pure: no reads, no writes. */
export function compareTeam(team: StateTeam, live: LiveMember[]): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const byId = new Map(live.map((member) => [member.userId, member]));
  const claimed = new Set<string>();
  for (const seat of team.seats) {
    const label = `${seat.id} (${seat.displayName})`;
    claimed.add(seat.mattermostUserId);
    const member = byId.get(seat.mattermostUserId);
    if (!member) {
      mismatches.push({
        kind: "missing", teamId: team.id, seatId: seat.id, field: "externalIdentities.mattermost.userId",
        message: `${label} externalIdentities.mattermost.userId: user '${seat.mattermostUserId}' is not an active member of the Mattermost team.`,
      });
      continue;
    }
    if (member.username !== seat.handle) {
      mismatches.push({
        kind: "username", teamId: team.id, seatId: seat.id, field: "externalIdentities.mattermost.username",
        message: `${label} externalIdentities.mattermost.username: state has '${seat.handle}', Mattermost has '${member.username}'.`,
      });
    }
    const role = seat.roles[0] ?? "";
    if (member.position.trim() !== role) {
      mismatches.push({
        kind: "position", teamId: team.id, seatId: seat.id, field: "roles",
        message: `${label} roles: state has '${role}', Mattermost profile position is '${member.position.trim() || "(empty)"}'.`,
      });
    }
  }
  for (const member of live) {
    if (claimed.has(member.userId) || !member.isBot) continue;
    mismatches.push({
      kind: "unexpected", teamId: team.id, field: "seats",
      message: `Bot @${member.username} (${member.userId}) is in the Mattermost team but no seat in state has that user.`,
    });
  }
  return mismatches;
}

/** Human accounts in the team that no seat claims. These are listed, not counted as mismatches. */
export function unclaimedHumans(team: StateTeam, live: LiveMember[]): LiveMember[] {
  const claimed = new Set(team.seats.map((seat) => seat.mattermostUserId));
  return live.filter((member) => !member.isBot && !claimed.has(member.userId));
}

/** Reads every state team's live membership and compares it. Never writes to either side. */
export async function checkConsistency(snapshot: StateSnapshot, reader: TeamMemberReader): Promise<TeamReport[]> {
  const reports: TeamReport[] = [];
  for (const team of snapshot.teams) {
    const live = await reader.listTeamMembers(team.mattermostTeamId);
    reports.push({ team, mismatches: compareTeam(team, live), unclaimedHumans: unclaimedHumans(team, live) });
  }
  return reports;
}

export function printConsistency(reports: TeamReport[], refreshed: string, write: (line: string) => void): number {
  write(`Mattermost vs indra-state | checked ${refreshed}`);
  if (reports.length === 0) write("No teams are recorded in state.");
  let total = 0;
  for (const { team, mismatches, unclaimedHumans: humans } of reports) {
    total += mismatches.length;
    write(`${team.displayName} (${team.slug}) | ${mismatches.length === 0 ? "matches state" : `${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}`}`);
    for (const mismatch of mismatches) write(`  ${mismatch.message}`);
    for (const human of humans) write(`  Info: user @${human.username} (${human.userId}) is in the Mattermost team without a seat in state; humans are not checked.`);
  }
  return total;
}
