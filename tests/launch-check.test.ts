import { describe, expect, it } from "vitest";
import { launchWarning, OWNER_START_COMMAND, parseProcessTable, seatServer, ttydAncestor, type LaunchFacts } from "../src/launch-check.js";

/** A fake `ps -A -o pid=,ppid=,args=` table. */
const table = parseProcessTable([
  "    1     0 /sbin/launchd",
  "  100     1 /Applications/iTerm.app/Contents/MacOS/iTerm2",
  "  110   100 -zsh",
  "  200     1 /opt/homebrew/bin/ttyd -p 0 tmux -L indra-ui new-session -A -s ui npm start",
  "  210   200 tmux -L indra-ui new-session -A -s ui -x 160 -y 48 npm start",
  "  300     1 tmux -L indra-ui new-session -A -s ui -x 160 -y 48 npm start",
  "  310   300 npm start",
  "  320   310 node dist/cli.js --ui",
  "  400   200 npm start",
  "  410   400 node dist/cli.js --ui",
  "  500     1 tmux -L indra-abc new-session -d -s chick-abc",
  "  600     1 tmux -L indra-other new-session -A -s ui",
  "  610   110 tmux -L indra-other attach -t ui",
  "  620   600 node dist/cli.js --ui",
].join("\n"));

const facts = (overrides: Partial<LaunchFacts>): LaunchFacts => ({ table, uiPid: 620, uiStartedAt: 1_000, seatSocket: "indra-abc", ...overrides });

describe("launch check", () => {
  it("parses the process table and walks ancestry to ttyd", () => {
    expect(table.get(410)).toEqual({ pid: 410, ppid: 400, args: "node dist/cli.js --ui" });
    expect(ttydAncestor(table, 410)?.pid).toBe(200);
    expect(ttydAncestor(table, 320)).toBeUndefined();
  });

  it("warns when the UI runs directly under ttyd, and records the new seats' server as ttyd-launched", () => {
    const result = launchWarning(facts({ uiPid: 410, server: { pid: 500, startedAt: 1_005 } }));
    expect(result.warning).toContain("runs under ttyd (pid 200)");
    expect(result.warning).toContain("macOS will attribute privacy prompts to ttyd");
    expect(result.warning).toContain(OWNER_START_COMMAND);
    expect(result.record).toEqual({ pid: 500, startedAt: 1_005, underTtyd: true });
  });

  it("warns when the client that created the UI's own tmux server is still under ttyd", () => {
    expect(launchWarning(facts({ uiPid: 320, tmuxEnv: "/private/tmp/tmux-501/indra-ui,300,0" })).warning).toContain("runs under ttyd (pid 200)");
  });

  it("does not warn for a UI started from the owner's terminal, and records the seats' server it started", () => {
    const result = launchWarning(facts({ tmuxEnv: "/private/tmp/tmux-501/indra-other,600,0", server: { pid: 500, startedAt: 1_000 } }));
    expect(result).toEqual({ record: { pid: 500, startedAt: 1_000, underTtyd: false } });
    expect(launchWarning(facts({}))).toEqual({});
  });

  it("warns when the seats' server predates the UI and has no matching record", () => {
    for (const record of [undefined, { pid: 500, startedAt: 900, underTtyd: false }, { pid: 501, startedAt: 800, underTtyd: false }]) {
      const result = launchWarning(facts({ server: { pid: 500, startedAt: 800 }, record }));
      expect(result.warning).toContain("seats' tmux server (socket indra-abc, pid 500) was started before this UI by a launcher Indra cannot verify");
      expect(result.warning).toContain(OWNER_START_COMMAND);
      expect(result.record).toBeUndefined();
    }
  });

  it("trusts an older seats' server recorded as started outside ttyd, and warns for one recorded under ttyd", () => {
    expect(launchWarning(facts({ server: { pid: 500, startedAt: 800 }, record: { pid: 500, startedAt: 800, underTtyd: false } }))).toEqual({});
    expect(launchWarning(facts({ server: { pid: 500, startedAt: 800 }, record: { pid: 500, startedAt: 800, underTtyd: true } })).warning).toContain("was started under ttyd");
  });

  it("reads the seats' server with one read-only query of Indra's own socket", async () => {
    const calls: string[][] = [];
    expect(await seatServer({ run: async (args) => { calls.push(args); return "500 800\n"; } }, "indra-abc")).toEqual({ pid: 500, startedAt: 800 });
    expect(calls).toEqual([["-L", "indra-abc", "display-message", "-p", "#{pid} #{start_time}"]]);
    expect(await seatServer({ run: async () => { throw new Error("no server running"); } }, "indra-abc")).toBeUndefined();
  });
});
