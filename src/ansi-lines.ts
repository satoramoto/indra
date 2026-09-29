import { redactSecrets } from "./redact.js";

/**
 * Turns `tmux capture-pane -e -p` output into styled lines the terminal UI can draw: SGR colours and attributes are
 * kept, every other escape and control character is dropped, and each line is redacted before it is cut to width.
 */

export interface MirrorStyle { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean }
export interface MirrorSpan { text: string; style: MirrorStyle }
export type MirrorLine = MirrorSpan[];

/** The 16 basic terminal colours, then the 256-colour cube and grey ramp are computed. */
const BASE16 = [
  "#000000", "#CD3131", "#0DBC79", "#E5E510", "#2472C8", "#BC3FBC", "#11A8CD", "#E5E5E5",
  "#666666", "#F14C4C", "#23D18B", "#F5F543", "#3B8EEA", "#D670D6", "#29B8DB", "#FFFFFF",
];
const hex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0").toUpperCase();
const rgb = (r: number, g: number, b: number) => "#" + hex(r) + hex(g) + hex(b);

/** The hex colour of a 256-colour palette index. */
export function color256(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return BASE16[index];
  if (index < 232) {
    const cube = index - 16;
    const level = (value: number) => value ? 55 + value * 40 : 0;
    return rgb(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6));
  }
  const grey = 8 + (index - 232) * 10;
  return rgb(grey, grey, grey);
}

/** Applies one SGR parameter list (the part between `ESC[` and `m`) to a style, returning the new style. */
export function applySgr(style: MirrorStyle, params: string): MirrorStyle {
  const codes = params === "" ? [0] : params.split(/[;:]/).map((part) => part === "" ? 0 : Number(part));
  let next: MirrorStyle = { ...style };
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index]!;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 7) next.inverse = true;
    else if (code === 22) { delete next.bold; delete next.dim; }
    else if (code === 23) delete next.italic;
    else if (code === 24) delete next.underline;
    else if (code === 27) delete next.inverse;
    else if (code >= 30 && code <= 37) next.fg = BASE16[code - 30];
    else if (code >= 90 && code <= 97) next.fg = BASE16[code - 90 + 8];
    else if (code === 39) delete next.fg;
    else if (code >= 40 && code <= 47) next.bg = BASE16[code - 40];
    else if (code >= 100 && code <= 107) next.bg = BASE16[code - 100 + 8];
    else if (code === 49) delete next.bg;
    else if (code === 38 || code === 48) {
      const key = code === 38 ? "fg" : "bg";
      if (codes[index + 1] === 5) {
        const colour = color256(codes[index + 2] ?? -1);
        if (colour) next[key] = colour;
        index += 2;
      } else if (codes[index + 1] === 2) {
        const [r, g, b] = [codes[index + 2], codes[index + 3], codes[index + 4]];
        if ([r, g, b].every((value) => typeof value === "number" && Number.isFinite(value))) next[key] = rgb(r!, g!, b!);
        index += 4;
      }
    }
  }
  return next;
}

const sameStyle = (a: MirrorStyle, b: MirrorStyle) => a.fg === b.fg && a.bg === b.bg && !!a.bold === !!b.bold && !!a.dim === !!b.dim
  && !!a.italic === !!b.italic && !!a.underline === !!b.underline && !!a.inverse === !!b.inverse;

// SGR, then any other CSI, OSC (BEL or ST terminated, or to the end of the line), DCS/SOS/PM/APC strings, and two-byte escapes.
const TOKEN = /\u001b\[([0-9;:]*)m|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?|\u009d[^\u0007\u009c\n]*[\u0007\u009c]?|\u001b[PX^_][^\u001b\n]*(?:\u001b\\)?|\u001b[ -/]*[0-~]?/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** The plain text of a styled line. */
export const lineText = (line: MirrorLine) => line.map((span) => span.text).join("");

function cut(line: MirrorLine, width: number): MirrorLine {
  const out: MirrorLine = [];
  let left = width;
  for (const span of line) {
    if (left <= 0) break;
    const chars = Array.from(span.text);
    out.push(chars.length <= left ? span : { text: chars.slice(0, left).join(""), style: span.style });
    left -= Math.min(chars.length, left);
  }
  return out;
}

/**
 * Parses captured pane text into at most `rows` styled lines of at most `width` characters, top first. The style
 * carries from one line to the next, as it does on the terminal. A line whose text holds anything token-shaped is
 * redacted and drawn unstyled, so a secret can never be split across spans and survive.
 */
export function ansiToLines(text: string, size: { rows: number; width: number }): MirrorLine[] {
  const rows = Math.max(0, Math.floor(size.rows));
  const width = Math.max(1, Math.floor(size.width));
  const raw = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").slice(0, rows);
  let style: MirrorStyle = {};
  return raw.map((source) => {
    const line: MirrorLine = [];
    const push = (chunk: string) => {
      const clean = chunk.replace(/\t/g, "  ").replace(CONTROL, "");
      if (!clean) return;
      const last = line.at(-1);
      if (last && sameStyle(last.style, style)) last.text += clean;
      else line.push({ text: clean, style: { ...style } });
    };
    let at = 0;
    for (const match of source.matchAll(TOKEN)) {
      push(source.slice(at, match.index));
      if (match[1] !== undefined) style = applySgr(style, match[1]);
      at = match.index! + match[0].length;
    }
    push(source.slice(at));
    const plain = lineText(line);
    const redacted = redactSecrets(plain);
    return cut(redacted === plain ? line : [{ text: redacted, style: {} }], width);
  });
}
