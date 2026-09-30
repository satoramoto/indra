import { describe, expect, it } from "vitest";
import {
  ansi256Index, ansi256Rgb, burnBuckets, halfBlockBar, headerGradient, hexRgb, paint, paintHex, sparkline, sprintProgress, supportsTruecolor, TokenBurn,
} from "../src/hub-paint.js";

describe("256-colour fallback", () => {
  it("maps truecolor to the nearest xterm-256 cube or grey entry", () => {
    expect(ansi256Index([0, 0, 0])).toBe(16);
    expect(ansi256Index([255, 255, 255])).toBe(231);
    expect(ansi256Index([255, 0, 0])).toBe(196);
    expect(ansi256Index(hexRgb("#5F87AF"))).toBe(67);
    // Mid greys land on the grey ramp, which is finer than the cube's diagonal.
    expect(ansi256Index([128, 128, 128])).toBe(244);
    expect(ansi256Index([30, 30, 30])).toBe(234);
    expect(ansi256Rgb(244)).toEqual([128, 128, 128]);
    expect(ansi256Rgb(67)).toEqual([95, 135, 175]);
  });

  it("snaps drawn colours only when truecolor is unavailable", () => {
    expect(paint("#67E8F9", true)).toEqual([0x67, 0xE8, 0xF9]);
    expect(paint("#67E8F9", false)).toEqual(ansi256Rgb(ansi256Index(hexRgb("#67E8F9"))));
    expect(paint("#67E8F9", false)).toEqual([95, 215, 255]);
    expect(paintHex("#7DD3FC", false)).toBe("#87D7FF");
    expect(paintHex("#7DD3FC", true)).toBe("#7DD3FC");
  });

  it("detects truecolor from the terminal's capabilities or COLORTERM", () => {
    expect(supportsTruecolor({ rgb: true }, {})).toBe(true);
    expect(supportsTruecolor(null, { COLORTERM: "truecolor" })).toBe(true);
    expect(supportsTruecolor({ rgb: false }, { COLORTERM: "24bit" })).toBe(true);
    expect(supportsTruecolor({ rgb: false }, {})).toBe(false);
    expect(supportsTruecolor(undefined, { COLORTERM: "yes" })).toBe(false);
  });
});

describe("header gradient", () => {
  it("gives every column a colour and loops seamlessly as it drifts", () => {
    const still = headerGradient(96, 0);
    expect(still).toHaveLength(96);
    expect(new Set(still.map(String)).size).toBeGreaterThan(20);
    expect(headerGradient(96, 1)).toEqual(still);
    expect(headerGradient(96, 0.25)).not.toEqual(still);
    // Dark enough for light bar text: no channel above the brightest stop.
    expect(Math.max(...still.flat())).toBeLessThanOrEqual(0x81);
  });
});

describe("sprint progress bar", () => {
  it("counts a fifth per stage and fills implement as tickets merge", () => {
    expect(sprintProgress({})).toBe(0);
    expect(sprintProgress({ stage: "planning" })).toBe(0);
    expect(sprintProgress({ stage: "implement", merged: 1, tickets: 4 })).toBeCloseTo(0.45);
    expect(sprintProgress({ stage: "implement", merged: 0, tickets: 0 })).toBeCloseTo(0.4);
    expect(sprintProgress({ stage: "retro" })).toBeCloseTo(0.8);
    expect(sprintProgress({ stage: "retro", closed: true })).toBe(1);
  });

  it("fills in half-cell steps", () => {
    expect(halfBlockBar(0, 4)).toEqual(["empty", "empty", "empty", "empty"]);
    expect(halfBlockBar(1 / 8, 4)).toEqual(["half", "empty", "empty", "empty"]);
    expect(halfBlockBar(0.5, 4)).toEqual(["full", "full", "empty", "empty"]);
    expect(halfBlockBar(5 / 8, 4)).toEqual(["full", "full", "half", "empty"]);
    expect(halfBlockBar(1.5, 4)).toEqual(["full", "full", "full", "full"]);
  });
});

describe("token sparkline", () => {
  const NOW = Date.parse("2026-09-29T15:00:00Z");
  const ago = (minutes: number) => NOW - minutes * 60_000;

  it("buckets the last hour's burn and drops older points", () => {
    expect(burnBuckets([{ at: ago(90), tokens: 5 }, { at: ago(50), tokens: 400 }, { at: ago(52), tokens: 100 }, { at: ago(1), tokens: 7 }, { at: NOW + 1, tokens: 9 }], NOW, 8))
      .toEqual([0, 500, 0, 0, 0, 0, 0, 7]);
  });

  it("draws two buckets per braille cell, scaled to the busiest, with any burn visible", () => {
    expect(sparkline([0, 0, 0, 0])).toBe("⠀⠀");
    expect(sparkline([4, 4])).toBe("⣿");
    expect(sparkline([0, 400, 0, 0, 0, 850, 0, 0])).toBe("⢠⠀⢸⠀");
    expect(sparkline([1, 1000])).toBe("⣸");
    expect(Array.from(sparkline(new Array(8).fill(3)))).toHaveLength(4);
  });

  it("turns rises in a live running total into burn, and a fall into a new baseline", () => {
    const burn = new TokenBurn();
    burn.observe("seat", 1000, ago(30));
    burn.observe("seat", 1000, ago(25));
    burn.observe("seat", 1600, ago(20));
    burn.observe("seat", 200, ago(10));
    burn.observe("seat", 500, ago(5));
    burn.observe("seat", undefined, ago(1));
    expect(burn.live("seat")).toEqual([{ at: ago(20), tokens: 600 }, { at: ago(5), tokens: 300 }]);
    expect(burn.live("other")).toEqual([]);
  });

  it("draws recorded sessions from before the hub looked, then only the rises it saw", () => {
    const burn = new TokenBurn();
    const recorded = [{ at: ago(40), tokens: 700 }, { at: ago(10), tokens: 300 }];
    expect(burn.series("seat", recorded)).toEqual(recorded);
    burn.observe("seat", 1000, ago(30));
    // The session recorded 10 minutes ago finished while the hub watched: it is the rise, not an extra point.
    burn.observe("seat", 1300, ago(10));
    expect(burn.series("seat", recorded)).toEqual([{ at: ago(40), tokens: 700 }, { at: ago(10), tokens: 300 }]);
    expect(burn.series("seat", recorded).reduce((sum, point) => sum + point.tokens, 0)).toBe(1000);
  });
});
