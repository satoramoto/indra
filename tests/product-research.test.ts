import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Shell } from "../src/command-shell.js";
import type { PlanningDocument } from "../src/planning.js";
import { productResearchReader, researchSource, MAX_RESEARCH_SOURCES, MAX_SOURCE_CHARS } from "../src/product-research.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const sha = "a".repeat(40);
const state = (): PlanningDocument => ({ $schema: "./schema/v1/state.schema.json", schemaVersion: 1, sprints: [], teams: [{ id: "team-one", project: { github: "acme/demo" }, externalIdentities: { mattermost: { teamId: "mm-team", homeChannelId: "home" } } }] });
async function fixture(issues: unknown = [], readme = "The control plane lets the owner steer by problems and value.") {
  const runtime = await mkdtemp(join(tmpdir(), "indra-research-")); dirs.push(runtime);
  const cwd = join(runtime, "projects/acme/demo");
  await mkdir(join(cwd, ".git"), { recursive: true });
  const run = vi.fn<Shell["run"]>(async (command, args) => {
    if (args[0] === "rev-parse") return { code: 0, stdout: sha, stderr: "" };
    if (args[0] === "show") return { code: readme ? 0 : 1, stdout: readme, stderr: "" };
    if (command === "gh") return { code: 0, stdout: JSON.stringify(issues), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  return { run, cwd, read: productResearchReader(runtime, { run }) };
}

describe("bounded cited Product research", () => {
  it("reads only the team's project, pins document citations to a commit and uses GET for open issues", async () => {
    const f = await fixture([{ number: 7, title: "Lost context", body: "Planning context is lost between sprints.", html_url: "https://untrusted.test" }, { number: 8, title: "A PR", body: "skip", pull_request: {} }]);
    const result = await f.read(state(), "team-one");
    expect(result.cwd).toBe(f.cwd);
    expect(result.sources).toContainEqual({ url: `https://github.com/acme/demo/blob/${sha}/README.md`, text: "The control plane lets the owner steer by problems and value." });
    expect(result.sources).toContainEqual({ url: "https://github.com/acme/demo/issues/7", text: "Lost context\nPlanning context is lost between sprints." });
    expect(result.sources).toHaveLength(3);
    expect(f.run.mock.calls.filter(([command]) => command === "gh")).toEqual([["gh", ["api", "--method", "GET", "repos/acme/demo/issues?state=open&sort=updated&per_page=20"], f.cwd]]);
    expect(f.run.mock.calls.every(([, , cwd]) => cwd === f.cwd)).toBe(true);
  });

  it("bounds source counts and text, redacts before truncation, and excludes malformed issue records", async () => {
    const issues = [{ number: -1, title: "invalid", body: "skip" }, { number: 1, title: {}, body: "skip" }, ...Array.from({ length: 20 }, (_, index) => ({ number: index + 2, title: "Issue", body: "x".repeat(20_000) }))];
    const f = await fixture(issues);
    const result = await f.read(state(), "team-one");
    expect(result.sources).toHaveLength(MAX_RESEARCH_SOURCES);
    expect(result.sources.every((source) => source.text.length <= MAX_SOURCE_CHARS)).toBe(true);
    const source = researchSource("https://github.com/acme/demo/issues/2", `Bearer ${"sample".repeat(3000)}`)!;
    expect(source.text).toBe("Bearer [redacted]");
    expect(researchSource(`https://github.com/acme/demo/blob/${"a1".repeat(20)}/README.md`, "A committed document.")?.url).toContain("a1".repeat(20));
  });

  it("includes the last two published retros of this team and ignores legacy closures", async () => {
    const f = await fixture();
    const input = state();
    input.planningGoals = [
      ["goal-old", "team-one", "retro-published", "2026-09-01"], ["goal-new", "team-one", "retro-published", "2026-09-02"],
      ["goal-latest", "team-one", "retro-published", "2026-09-03"], ["goal-other", "team-two", "retro-published", "2026-09-04"],
      ["goal-legacy", "team-one", "legacy-migration", "2026-09-05"],
    ].map(([id, teamId, kind, closedAt]) => ({ id, teamId, ceremony: { closure: { closedAt, evidence: { kind } } } })) as PlanningDocument["planningGoals"];
    const result = await f.read(input, "team-one");
    expect(result.sources.filter((source) => source.url.includes("/retros/")).map((source) => source.url.split("/").at(-1))).toEqual(["goal-latest.md", "goal-new.md"]);
  });

  it("never creates evidence from inaccessible or malformed data and does not echo diagnostics", async () => {
    const f = await fixture({}, "");
    await expect(f.read(state(), "team-one")).rejects.toThrow("No cited project research");
    f.run.mockResolvedValue({ code: 1, stdout: "private diagnostics", stderr: "private diagnostics" });
    await expect(f.read(state(), "team-one")).rejects.not.toThrow("private diagnostics");
  });

  it("fails before executing anything when the team's home/project is absent", async () => {
    const f = await fixture(); const input = state();
    input.teams = [{ id: "team-one", externalIdentities: { mattermost: { teamId: "mm-team" } } }];
    await expect(f.read(input, "team-one")).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    for (const url of ["file:///local", "https://user:pass@example.test", "https://example.test?credential=sample"]) expect(() => researchSource(url, "A source")).toThrow("Invalid research source");
  });
});
