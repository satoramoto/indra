import type { OwnerControlPorts, OwnerControlServices } from "./control-adapters.js";
import type { SeatLifecyclePorts } from "./autonomy-ports.js";
import { processShell, type Shell } from "./command-shell.js";
import { runGh } from "./git-gh.js";
import { GITHUB_REPO } from "./local-state.js";
import { MattermostClient } from "./mattermost.js";
import { readBotToken, type BotTokenOptions } from "./planning-mattermost.js";
import { opCredential } from "./service-account.js";
import { hasUnfinishedSeatWork } from "./planning.js";
import { SeatLifecycle } from "./seat-lifecycle.js";
import type { SeatRecord, TeamRecord } from "./state-domain.js";

/** Reads the named bot's existing credential and authenticates it using GET only; nothing creates an account. */
export async function credentialIdentity(checkout: string, seat: SeatRecord, read = readBotToken, request: typeof fetch = fetch,
  credential: () => Promise<BotTokenOptions> = () => opCredential(checkout)): ReturnType<SeatLifecyclePorts["credentialIdentity"]> {
  try {
    const username = seat.externalIdentities.mattermost.username;
    const token = await read(username, { ...await credential(), headless: true });
    if (!token.trim()) return;
    const me = await new MattermostClient("https://mattermost.newegypt.io", token, request).get("/users/me") as Record<string, unknown> | null;
    if (!me || typeof me.id !== "string" || !me.id.trim() || me.username !== username || me.is_bot !== true || me.delete_at
      || (seat.externalIdentities.mattermost.userId && seat.externalIdentities.mattermost.userId !== me.id)) return;
    return { userId: me.id, username, isBot: true };
  } catch { return undefined; } // Missing, rejected or malformed credentials stay pending, without exposing response/error bodies.
}

/** A missing saved URL is not evidence: the agent may have opened a PR before its result could be persisted. */
export async function branchHasNoPr(checkout: string, team: TeamRecord, branch: string, shell: Shell = processShell): Promise<boolean> {
  const github = team.project?.github;
  if (!github || !GITHUB_REPO.test(github)) return false;
  try {
    // No base filter: a failed `pr edit --base` may have left this branch targeting main or another base.
    const result = await runGh(shell, ["api", `repos/${github}/pulls`, "--method", "GET",
      "-f", "state=all", "-f", `head=${github.split("/")[0]}:${branch}`, "-f", "per_page=1"], checkout);
    if (result.code !== 0) return false;
    const prs: unknown = JSON.parse(result.stdout);
    return Array.isArray(prs) && prs.length === 0;
  } catch { return false; } // Preserve work on transport/parse errors; never expose command output.
}

export function createOwnerControls({ store, processes }: OwnerControlServices): OwnerControlPorts {
  const lifecycle = new SeatLifecycle(store, {
    credentialIdentity: (_team, seat) => credentialIdentity(store.checkout, seat),
    branchHasNoPr: (team, branch) => branchHasNoPr(store.checkout, team, branch),
    // Called with the runner's turn lock held: no local step is in flight, and durable work must also be settled.
    workSettled: async (_teamId, seatId) => !(await store.read()).planningGoals?.some((goal) => hasUnfinishedSeatWork(goal, seatId)),
    startSeat: async (_team, seat) => {
      if (!processes.start) throw new Error("Seat process start is unavailable.");
      await processes.start(seat.id);
    },
    retireSeat: async (_team, seat) => processes.stop(seat.id),
  });
  return { lifecycle: {
    add: (request) => lifecycle.add(request), remove: (request) => lifecycle.remove(request),
    reconcile: async () => { await lifecycle.provisionProductSeats(); await lifecycle.reconcile(); },
  } };
}
