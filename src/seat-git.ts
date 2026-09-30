/**
 * Git settings for everything a seat runs. The sandbox cannot reach the owner's commit signer, and seat commits must
 * not claim the owner's identity, so seat git commits unsigned under the seat's own name. The settings travel in the
 * environment (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`); the owner's git config is never touched.
 */
export interface SeatGitIdentity { displayName: string; username: string }

/** A non-routable placeholder address that no real GitHub account owns. */
export const seatGitEmail = (username: string) => `${username}@yahaha.invalid`;

/** `env` plus the seat's unsigned-commit settings and identity. Existing `GIT_CONFIG_n` entries are kept. */
export function withSeatGit(env: NodeJS.ProcessEnv, seat: SeatGitIdentity): NodeJS.ProcessEnv {
  const email = seatGitEmail(seat.username);
  const settings: [string, string][] = [["commit.gpgsign", "false"], ["tag.gpgsign", "false"], ["user.name", seat.displayName], ["user.email", email]];
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  const start = Number.isInteger(existing) && existing > 0 ? existing : 0;
  const out: NodeJS.ProcessEnv = { ...env, GIT_CONFIG_COUNT: String(start + settings.length),
    GIT_AUTHOR_NAME: seat.displayName, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: seat.displayName, GIT_COMMITTER_EMAIL: email };
  settings.forEach(([key, value], index) => { out[`GIT_CONFIG_KEY_${start + index}`] = key; out[`GIT_CONFIG_VALUE_${start + index}`] = value; });
  return out;
}
