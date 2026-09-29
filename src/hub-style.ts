/**
 * The hub's one glyph set and one palette. Every glyph is one terminal column wide and none is an emoji, so columns
 * line up in any monospace font without a Nerd Font. Tests check both.
 */
export const GLYPH = {
  /** The selected row. */
  selected: "▸",
  /** A seat's or ticket's state, always in the state's colour. */
  state: { running: "●", waiting: "◐", needs: "◆", failed: "✗", done: "✓", idle: "○" },
  /** One pipeline stage: build, review, fix, ci, merge, in that order. */
  stage: { done: "■", active: "◧", pending: "□", skipped: "─", failed: "✗" },
  /** A CI result, coloured green, yellow or red. */
  ci: "●",
  /** A pull request, followed by its number: `⎇ #103`. */
  pr: "⎇",
  /** A Mattermost link. */
  link: "⇗",
  /** A problem or warning. */
  warn: "▲",
  /** A token total. */
  sum: "Σ",
  /** The runtime connection in the header. */
  dot: "●",
  arrow: "→",
  separator: "·",
  bullet: "•",
  crumb: "›",
  ok: "✓",
  fail: "✗",
} as const;

/** Every glyph as a flat list, for the width and emoji checks. */
export function allGlyphs(value: unknown = GLYPH): string[] {
  return typeof value === "string" ? [value] : Object.values(value as Record<string, unknown>).flatMap((item) => allGlyphs(item));
}

/**
 * A small palette: neutral text for content, dim for secondary details, one accent (section titles, the selection and
 * key names) and semantic colours only for state: green ok, yellow waiting or running, red failed or needs you, blue links.
 */
export const PALETTE = {
  background: "#0F172A",
  selected: "#1E293B",
  rule: "#334155",
  text: "#E2E8F0",
  dim: "#8391A7",
  accent: "#A5B4FC",
  ok: "#4ADE80",
  wait: "#FACC15",
  bad: "#F87171",
  link: "#7DD3FC",
} as const;

/** The pulse's low phase: the colour half way to the background. */
export function faded(color: string, background: string = PALETTE.background): string {
  const channel = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  return "#" + [0, 1, 2].map((index) => Math.round((channel(color, index) + channel(background, index)) / 2).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** How often the pulse flips between normal and faded. */
export const PULSE_MS = 1500;
