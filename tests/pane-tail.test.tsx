import { describe, expect, it } from "vitest";
import { sanitizePaneText } from "../src/pane-tail.js";

describe("plain pane text", () => {
  it("strips escapes and control characters, redacts, keeps the last lines and cuts them to width", () => {
    const text = "old\n\u001b[1;32mgreen\u001b[0m \u001b]0;title\u0007done\u0007\r\nbell\u0008 x\ttab\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n" + "y".repeat(50) + "\n\n  \n";
    const lines = sanitizePaneText(text, { lines: 4, width: 20 });
    expect(lines).toEqual(["green done", "bell x  tab", "token=[redacted]", "y".repeat(19) + "…"]);
    for (const line of lines) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("drops an unterminated OSC or DCS escape only to the end of its line", () => {
    const text = "before\u001b]0;title with no end\nkept one\n\u001bPq#0;2;0;0;0 sixel\nkept two\n\u009d8;;link\nkept three\n\u001b]0;ok\u0007 shown\n";
    expect(sanitizePaneText(text, { lines: 10, width: 40 })).toEqual(["before", "kept one", "", "kept two", "", "kept three", " shown"]);
  });

  it("redacts before truncating so a cut never shows part of a secret", () => {
    const [line] = sanitizePaneText("key ghp_abcdefghijklmnopqrstuvwxyz0123456789", { lines: 1, width: 10 });
    expect(line).toBe("key [reda…");
    expect(line).not.toContain("ghp_");
  });
});
