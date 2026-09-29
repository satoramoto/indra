/**
 * The keys for watching a seat's live process, in plain words. The UI, the help screen and the status line Indra
 * shows inside a watched seat all use these, so they never disagree. Nothing here names the terminal multiplexer.
 */

/** The tmux key name bound on Indra's own seat sockets to return to Indra. Headless agent CLIs never see it. */
export const RETURN_KEY_TMUX = "C-]";
/** How the return key is written for the owner. */
export const RETURN_KEY = "Ctrl-]";

export const RETURN_HINT = `${RETURN_KEY} back to Indra`;
export const SCROLL_HINT = "mouse wheel or PgUp scrolls back · q, Esc or scrolling to the bottom returns to live";

/** Shown in Indra before it switches the screen to a seat, and at the bottom of the watched seat. */
export const WATCH_HINT = `${RETURN_HINT} · ${SCROLL_HINT}`;

/** At the bottom of a seat the owner drives. */
export const DRIVE_HINT = `${RETURN_HINT} · the task keeps running and Indra still waits for its result`;

/** Shown in Indra before it switches the screen to a seat the owner drives. */
export const driveWarning = (seat: string) => `You're driving ${seat}'s live session. ${RETURN_KEY} returns to Indra.`;

/** Shown instead when drive falls back to watching: the seat has no headed run to type into. */
export const driveFallback = (seat: string) => `${seat} is not in a headed run, so there is nothing to drive; watching read-only instead · ${WATCH_HINT}`;

/** How long Indra shows the hint before it switches the screen to the seat. */
export const WATCH_HINT_MS = 1200;
