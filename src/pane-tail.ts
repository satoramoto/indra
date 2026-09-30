import { redactSecrets } from "./redact.js";

export interface PaneTailSize { lines: number; width: number }

// CSI, OSC (BEL or ST terminated), DCS/SOS/PM/APC strings, and two-byte escapes. A string escape ends at its
// terminator or at the end of its line, so an unterminated one hides only the rest of that line, not the text.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b\n]*(?:\u0007|\u001b\\)?|\u009d[^\u0007\u009c\n]*[\u0007\u009c]?|\u001b[PX^_][^\u001b\n]*(?:\u001b\\)?|\u001b[ -/]*[0-~]/g;

function truncate(line: string, width: number): string {
  const chars = Array.from(line);
  return chars.length <= width ? line : chars.slice(0, Math.max(0, width - 1)).join("") + "…";
}

/**
 * Makes captured terminal text safe to draw as plain text (the transcript uses it): strips terminal escapes and
 * control characters, redacts anything token-shaped, drops trailing blank lines, and keeps the last `lines` lines cut
 * to `width` characters. Redaction runs before truncation so a cut can never expose part of a secret.
 */
export function sanitizePaneText(text: string, size: PaneTailSize): string[] {
  const width = Math.max(1, Math.floor(size.width));
  const count = Math.max(0, Math.floor(size.lines));
  const plain = text
    .replace(ESCAPES, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
  const lines = redactSecrets(plain).split("\n").map((line) => line.trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  return count ? lines.slice(-count).map((line) => truncate(line, width)) : [];
}
