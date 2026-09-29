/**
 * Pure colour and glyph maths for the hub's per-cell drawing (hub-canvas.tsx): the header gradient, the half-block
 * sprint progress bar, braille token sparklines and the 256-colour fallback. Nothing here touches the renderer.
 */

import { PALETTE } from "./hub-style.js";

export type Rgb = readonly [number, number, number];

export function hexRgb(hex: string): Rgb {
  const value = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1];
  if (!value) throw new Error("Not a #RRGGBB colour: " + hex);
  const n = Number.parseInt(value, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbHex = (rgb: Rgb) => "#" + rgb.map((part) => Math.round(part).toString(16).padStart(2, "0")).join("").toUpperCase();

const clamp01 = (value: number) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const t = clamp01(amount);
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t].map(Math.round) as unknown as Rgb;
}

/** The xterm 256-colour cube levels (indices 16–231); 232–255 are 24 greys from 8 to 238. */
const CUBE = [0, 95, 135, 175, 215, 255];
const nearestLevel = (value: number) => CUBE.reduce((best, level, index) => Math.abs(level - value) < Math.abs(CUBE[best] - value) ? index : best, 0);
const distance = (a: Rgb, b: Rgb) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** The palette colour of an xterm-256 index from 16 up; the first 16 are terminal-themed and never chosen. */
export function ansi256Rgb(index: number): Rgb {
  if (index >= 232) { const grey = 8 + (index - 232) * 10; return [grey, grey, grey]; }
  const cube = index - 16;
  return [CUBE[Math.floor(cube / 36) % 6], CUBE[Math.floor(cube / 6) % 6], CUBE[cube % 6]];
}

/** The nearest fixed xterm-256 colour (cube or grey ramp) to a truecolor value. */
export function ansi256Index(rgb: Rgb): number {
  const [r, g, b] = rgb.map(nearestLevel);
  const cube = 16 + 36 * r + 6 * g + b;
  const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
  const greyStep = Math.min(23, Math.max(0, Math.round((mean - 8) / 10)));
  const grey = 232 + greyStep;
  return distance(rgb, ansi256Rgb(grey)) < distance(rgb, ansi256Rgb(cube)) ? grey : cube;
}

/** A colour as the terminal will show it: itself with truecolor, else snapped to the 256-colour palette. */
export const paint = (color: Rgb | string, truecolor: boolean): Rgb => {
  const rgb = typeof color === "string" ? hexRgb(color) : color;
  return truecolor ? rgb : ansi256Rgb(ansi256Index(rgb));
};
export const paintHex = (color: string, truecolor: boolean) => truecolor ? color : rgbHex(paint(color, false));

/**
 * Truecolor when the terminal reports it (OpenTUI's capability probe) or advertises it in `COLORTERM`; otherwise the
 * hub assumes 256 colours, which every terminal tmux supports can show.
 */
export function supportsTruecolor(capabilities: { rgb?: boolean } | null | undefined, env: Record<string, string | undefined> = process.env): boolean {
  if (capabilities?.rgb) return true;
  return /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "");
}

/**
 * Header bar stops: the palette's own dark slates (background, selection, rule), close together so the bar reads as
 * one calm band and its slow drift is barely there. The bar text stays legible on every stop.
 */
const HEADER_STOPS: Rgb[] = [hexRgb(PALETTE.selected), hexRgb("#243247"), hexRgb(PALETTE.rule), hexRgb("#243247")];

/**
 * One colour per column of the header bar. `phase` (0–1, wrapping) slides the gradient sideways; the stops loop, so
 * any phase is seamless.
 */
export function headerGradient(width: number, phase: number): Rgb[] {
  const stops = [...HEADER_STOPS, HEADER_STOPS[0]];
  const shift = ((phase % 1) + 1) % 1;
  return Array.from({ length: Math.max(0, width) }, (_, x) => {
    const position = ((x / Math.max(1, width) + shift) % 1) * (stops.length - 1);
    const index = Math.floor(position);
    return mix(stops[index], stops[index + 1], position - index);
  });
}

/** The fill colour of each ceremony stage, and of a closed sprint. */
/** One colour for an open sprint's bar (the accent) and the ok green for a closed one: no colour per stage. */
export const STAGE_COLOR: Record<"planning" | "proposal" | "implement" | "release" | "retro" | "closed", string> = {
  planning: PALETTE.accent, proposal: PALETTE.accent, implement: PALETTE.accent, release: PALETTE.accent, retro: PALETTE.accent, closed: PALETTE.ok,
};
export const TRACK_COLOR: string = PALETTE.rule;

/**
 * How far a sprint is through its ceremony, 0–1: each of the five stages is a fifth, and implement fills its fifth as
 * tickets merge. A closed sprint is full.
 */
export function sprintProgress(input: { stage?: string; closed?: boolean; merged?: number; tickets?: number }): number {
  if (input.closed) return 1;
  const stages = ["planning", "proposal", "implement", "release", "retro"];
  const at = input.stage ? stages.indexOf(input.stage) : -1;
  if (at < 0) return 0;
  const within = input.stage === "implement" && input.tickets ? (input.merged ?? 0) / input.tickets : 0;
  return clamp01((at + clamp01(within)) / stages.length);
}

export type BarCell = "full" | "half" | "empty";
/**
 * A bar `width` cells wide filled to `fraction` in half-cell steps. A full cell is `▀` over the fill (a lighter top
 * half gives it a sheen), the leading half cell is `▄`, and the rest is track.
 */
export function halfBlockBar(fraction: number, width: number): BarCell[] {
  const halves = Math.round(clamp01(fraction) * width * 2);
  return Array.from({ length: Math.max(0, width) }, (_, x) => halves >= 2 * (x + 1) ? "full" : halves === 2 * x + 1 ? "half" : "empty");
}
export const BAR_GLYPH: Record<BarCell, string> = { full: "▀", half: "▄", empty: " " };

/** Token burn in fixed buckets over a window ending `now`, oldest first. Points outside the window are dropped. */
export function burnBuckets(points: readonly { at: number; tokens: number }[], now: number, buckets = 8, windowMs = 3_600_000): number[] {
  const result = new Array<number>(buckets).fill(0);
  const start = now - windowMs;
  for (const point of points) {
    if (!(point.at > start && point.at <= now) || !(point.tokens > 0)) continue;
    const index = Math.min(buckets - 1, Math.floor((point.at - start) / (windowMs / buckets)));
    result[index] += point.tokens;
  }
  return result;
}

// Braille dots, bottom row first: left column 7,3,2,1 and right column 8,6,5,4.
const LEFT = [0x40, 0x04, 0x02, 0x01];
const RIGHT = [0x80, 0x20, 0x10, 0x08];
/**
 * Two values per braille character, each a bar of up to four dots scaled to the largest value. Any burn at all shows
 * at least one dot; no burn is the blank braille cell, so the column keeps its width.
 */
export function sparkline(values: readonly number[]): string {
  const max = Math.max(0, ...values.filter(Number.isFinite));
  const level = (value: number | undefined) => !value || !(value > 0) || !max ? 0 : Math.max(1, Math.round((value / max) * 4));
  let text = "";
  for (let index = 0; index < values.length; index += 2) {
    let bits = 0;
    for (let dot = 0; dot < level(values[index]); dot++) bits |= LEFT[dot];
    for (let dot = 0; dot < level(values[index + 1]); dot++) bits |= RIGHT[dot];
    text += String.fromCharCode(0x2800 + bits);
  }
  return text;
}

/**
 * Live token burn per seat, from the running totals the hub already shows (recorded sessions plus the headed run in
 * progress): each rise between two looks is burn at the later look. A fall (a new assignment starting from zero)
 * resets the baseline. Kept in memory for the window only.
 */
export class TokenBurn {
  private readonly last = new Map<string, number>();
  private readonly first = new Map<string, number>();
  private readonly points = new Map<string, { at: number; tokens: number }[]>();
  constructor(private readonly windowMs = 3_600_000) {}

  observe(key: string, total: number | undefined, at: number): void {
    if (total === undefined || !Number.isFinite(total)) return;
    const previous = this.last.get(key);
    this.last.set(key, total);
    if (!this.first.has(key)) this.first.set(key, at);
    if (previous === undefined || total <= previous) return;
    const kept = (this.points.get(key) ?? []).filter((point) => point.at > at - this.windowMs);
    kept.push({ at, tokens: total - previous });
    this.points.set(key, kept);
  }

  live(key: string): { at: number; tokens: number }[] { return this.points.get(key) ?? []; }

  /**
   * The burn to draw: recorded sessions that finished before the hub first looked at this seat, then the rises it has
   * seen since. A session finishing while the hub watches is already in the rises, so it is never counted twice.
   */
  series(key: string, recorded: readonly { at: number; tokens: number }[]): { at: number; tokens: number }[] {
    const since = this.first.get(key) ?? Infinity;
    return [...recorded.filter((point) => point.at < since), ...this.live(key)];
  }
}
