import { describe, expect, it } from "vitest";
import { RETRO_DIGEST_CHARS, retroDigest, retroDigestPointer } from "../src/retro-digest.js";

const legacyPath = "docs/retros/goal-88dd199e.md";
const phasedPath = "docs/retros/goal-96296dff.md";
const proposals = [
  "- Owner proposal (not applied): Consider improving recording for the explicitly missing historical evidence. [missing]",
  "- Owner proposal (not applied): Consider a pre-review check for the recorded review findings. [review-1]",
  "- Owner proposal (not applied): Consider a pre-review check for the recorded review findings. [review-8]",
];
const poorly = [
  "- Historical evidence is incomplete; unavailable measurements remain unknown. [missing]",
  "- Review for outcome-1 recorded 3 finding(s). [review-1]",
  "- Review for outcome-2 recorded 3 finding(s). [review-2]",
  "- Review for outcome-8 recorded 4 finding(s). [review-8]",
];
const review1 = "- [review-1] outcome-1 (https://github.com/satoramoto/indra/pull/57): [P1] src/ceremony.ts:129 — Exact SHA equality rejects a running descendant build containing the sprint merge.";
const review4 = "- [review-4] outcome-4 (https://github.com/satoramoto/indra/pull/56): No findings recorded.";
const legacy = (findings: string[] = []) => [
  "Bringing the parts together.", "", "# Sprint retrospective: goal-88dd199e", "",
  "Snapshot cutoff: 2026-09-29T06:51:18.152Z. Recorded evidence only; unknown does not mean zero.", "",
  "## What went well", "",
  "- The released build was recorded running by this retrospective's cutoff. [release-running]",
  "- Review for outcome-4 recorded 0 finding(s). [review-4]", "",
  "## What went poorly", "", ...poorly, "",
  "## Owner proposals", "", ...proposals, "",
  "Proposals require the owner's decision. This retrospective applies no configuration or workflow changes.", "",
  "## Per-seat wall time (ms)", "",
  "| Seat | Through cutoff | Retro generation | Accounted total |", "| --- | --- | --- | --- |",
  "| seat-001 | unknown | 19468 | unknown |", "| Total | unknown | 19468 | unknown |", "",
  "## Per-session token usage", "",
  "Session labels are local to this document. Totals cover supplied sessions only.", "",
  "| Session | Seat | Invocations | Input | Uncached input | Cached input | Cache write | Output | Reasoning output | Input + output |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  "| session-001 | seat-001 | 1 | unknown | unknown | unknown | unknown | unknown | unknown | unknown |",
  "| session-043 | seat-003 | 1 | 15216303 | unknown | 14966400 | 0 | 83858 | 41706 | 15300161 |",
  "| Total |  | 60 | unknown | unknown | unknown | unknown | unknown | unknown | unknown |", "",
  "## Review findings", "", review1, "Bringing the parts together.", "", review4, ...findings, "",
  "## Fix and conflict rounds", "", "| Evidence | Outcome | Fix | Conflict |", "| --- | --- | --- | --- |", "| Total recorded |  | unknown | unknown |", "",
  "## Failures and retries [failures]", "", "| At | Outcome | Recorded failure | Retries |", "| --- | --- | --- | --- |", "| Total recorded |  | unknown | unknown |", "",
  "## Ceremony stage time (ms)", "", "| Stage | Entered | Through | Elapsed |", "| --- | --- | --- | --- |", "| retro | 2026-09-29T06:47:50.721Z | 2026-09-29T06:51:18.152Z | 207431 |", "",
  "## Missing historical data [missing]", "",
  "- Failure/retry history is unavailable; an empty record set does not establish zero.",
  "- seat-001: historical wall time is missing or ambiguous.",
  "- session-043: missing or ambiguous token counters (uncachedInputTokens).", "",
  "Retro-generation usage has unreported counters, shown as unknown.", "",
].join("\n");
const phased = [
  "# Sprint retrospective: goal-96296dff", "", "Snapshot cutoff: 2026-09-29T10:49:13.017Z.", "",
  "## What went well", "", "- The released build was recorded running by this retrospective's cutoff. [release-running]", "",
  "## What went poorly", "", "- Historical evidence is incomplete; unavailable measurements remain unknown. [missing]", "",
  "## Owner proposals", "", "- Owner proposal (not applied, implement phase): Consider balancing outcome size across seats in future proposals. [implement-slowest-seat]", "",
  "Proposals require the owner's decision. This retrospective applies no configuration or workflow changes.", "",
  "## Process phases", "", "Code computes every phase fact from recorded evidence through the snapshot cutoff; unknown does not mean zero.", "",
  "| Phase | Entered | Through | Elapsed (ms) | Elapsed | Evidence |", "| --- | --- | --- | --- | --- | --- |",
  "| planning | 2026-09-29T06:56:02.396Z | 2026-09-29T06:56:42.701Z | 40305 | 40s | planning-time |", "",
  "Retro time is elapsed through the snapshot cutoff only. Its eventual closure duration is unknown. [release-running]", "",
  "### Planning", "", "| Fact | Value | Evidence |", "| --- | --- | --- |", "| Clarification turns | 1 | planning-turns |", "",
  "- Worked: Planning recorded 1 clarification turn(s) and no failed turns. [planning-turns]", "",
  "### Proposal", "", "| Fact | Value | Evidence |", "| --- | --- | --- |", "| Draft attempts | unknown | proposal-drafts |", "",
  "No supported reflection selected for this phase.", "",
  "### Implement", "", "| Fact | Value | Evidence |", "| --- | --- | --- |", "| Slowest seat | seat-002 | implement-slowest-seat |", "",
  "| Seat | Outcomes | Attempts | Claim-to-finish time |", "| --- | --- | --- | --- |", "| seat-002 | 1 | 1 | 15m 59s |", "",
  "- Worked: 4 review(s) recorded no findings. [implement-reviews]",
  "- Noted: seat-002 was the slowest seat at 15m 59s, the implement critical path. [implement-slowest-seat]", "",
  "## Per-seat wall time (ms)", "", "| Seat | Through cutoff | Retro generation | Accounted total |", "| --- | --- | --- | --- |", "| seat-001 | unknown | 59394 | unknown |", "",
  "## Per-session token usage", "", "| Session | Seat | Invocations | Input |", "| --- | --- | --- | --- |",
  "| session-001 | seat-001 | 2 | 765210 |", "| session-002 | seat-002 | 1 | 2598965 |", "",
  "## Review findings", "", "- [review-1] outcome-1 (https://github.com/satoramoto/indra/pull/75): No findings recorded.", "",
  "## Missing historical data [missing]", "", "- session-001: missing or ambiguous token counters (uncachedInputTokens).", "",
].join("\n");
const digest = (summary: string, path = legacyPath) => retroDigest({ goalId: path.slice(12, -3), path, summary });

describe("retro digest", () => {
  it("keeps proposals and poor results while dropping tables, counters and noise", () => {
    const result = digest(legacy());
    for (const line of [...proposals, ...poorly, review1, review4]) expect(result).toContain(line);
    for (const text of ["session-043", "missing or ambiguous token counters", "Bringing the parts together", "historical wall time", "Proposals require", "# Sprint retrospective"]) expect(result).not.toContain(text);
    expect(result.split("\n").some((line) => line.startsWith("|"))).toBe(false);
  });

  it("orders sections by priority and groups phase reflections under their headings", () => {
    const result = digest(phased, phasedPath);
    const order = [
      "- Owner proposal (not applied, implement phase)", "- Historical evidence is incomplete", "- The released build was recorded running",
      "### Implement", "- Noted: seat-002 was the slowest seat", "[review-1]",
    ].map((text) => result.indexOf(text));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(result).toContain("### Planning\n- Worked: Planning recorded 1 clarification turn(s)");
    for (const text of ["| Fact", "No supported reflection", "session-00", "### Proposal", "Code computes", "Retro time is elapsed"]) expect(result).not.toContain(text);
    expect(result).not.toContain(retroDigestPointer(phasedPath));
    expect(result.length).toBeLessThanOrEqual(RETRO_DIGEST_CHARS);
  });

  it("holds the cap and ends with the full retro pointer", () => {
    const findings = Array.from({ length: 40 }, (_, i) => `- [review-${i + 10}] outcome-${i} (https://github.com/satoramoto/indra/pull/${i}): [P2] src/x.ts:${i} — ${"long finding text ".repeat(8)}`);
    const result = digest(legacy(findings));
    expect(result.length).toBeLessThanOrEqual(RETRO_DIGEST_CHARS);
    expect(result.endsWith(`\n${retroDigestPointer(legacyPath)}`)).toBe(true);
    for (const line of [...proposals, ...poorly]) expect(result).toContain(line);
    expect(result).not.toContain("session-043");
  });

  it("falls back to a capped prefix plus the pointer for unknown shapes", () => {
    const path = "docs/retros/goal-notes.md";
    const long = digest(`# Notes\n\n${"plain line\n".repeat(1000)}`, path);
    expect(long.length).toBeLessThanOrEqual(RETRO_DIGEST_CHARS);
    expect(long.startsWith("# Notes")).toBe(true);
    expect(long.endsWith(`\n${retroDigestPointer(path)}`)).toBe(true);
    expect(digest("\n# Notes\nOne line\n", path)).toBe(`# Notes\nOne line\n${retroDigestPointer(path)}`);
  });

  it("is deterministic and never throws", () => {
    expect(digest(legacy())).toBe(digest(legacy()));
    const path = "docs/retros/goal-empty.md";
    expect(digest("", path)).toBe(retroDigestPointer(path));
    expect(() => digest(undefined as unknown as string, path)).not.toThrow();
    expect(digest(undefined as unknown as string, path)).toBe(retroDigestPointer(path));
    expect(digest(phased.replace(/\n/g, "\r\n"), phasedPath)).toBe(digest(phased, phasedPath));
    expect(digest("# Notes\r\nOne line\r\n", path)).toBe(digest("# Notes\nOne line\n", path));
    expect(retroDigest(null as unknown as Parameters<typeof retroDigest>[0])).toBe(retroDigestPointer("(unknown path)"));
  });

  it("returns only the pointer when known sections carry no bullets", () => {
    const path = "docs/retros/goal-bare.md";
    expect(digest("## What went well\n\nNothing recorded.\n\n## Process phases\n\n### Planning\n\n| Fact | Value |\n", path)).toBe(retroDigestPointer(path));
  });
});
