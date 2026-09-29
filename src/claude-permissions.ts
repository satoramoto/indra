import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { WriteAccess } from "./codex-runtime.js";
import { RuntimeStop } from "./runtime-facts.js";

async function gitWritePaths(cwd: string): Promise<string[]> {
  let gitDir: string | undefined;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    try {
      if ((await stat(dotGit)).isDirectory()) gitDir = dotGit;
      else {
        const pointer = /^gitdir: (.+)$/.exec((await readFile(dotGit, "utf8")).trim());
        if (!pointer) throw new Error();
        gitDir = resolve(dir, pointer[1]);
      }
      break;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (dirname(dir) === dir) break;
  }
  if (!gitDir) return [];
  // Claude grants this common directory from the worktree layout itself.
  const paths = [gitDir, ...(basename(dirname(gitDir)) === "worktrees" ? [dirname(dirname(gitDir))] : [])];
  try { return [...paths, resolve(gitDir, (await readFile(join(gitDir, "commondir"), "utf8")).trim())]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return paths;
}

async function readOnlyWritePaths(cwd: string): Promise<string[]> {
  try {
    const workingDir = await realpath(cwd);
    const tempName = `claude-${process.getuid?.() ?? 0}`;
    // Claude 2.1.283/SRT skip Linux denies outside an allowed write root. Deny
    // each implicit root, including linked-worktree metadata and both temp paths.
    // Keep / for macOS; allowing / just to deny it can undo managed read denies.
    const paths = ["/", resolve(cwd), workingDir, ...await gitWritePaths(workingDir),
      "/tmp/claude", "/private/tmp/claude", join(homedir(), ".npm", "_logs"), join(homedir(), ".claude", "debug"),
      resolve(workingDir, process.env.CLAUDE_CODE_TMPDIR || "/tmp", tempName), join("/tmp", tempName)];
    const resolved = await Promise.all(paths.map(async (path) => {
      try { return await realpath(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return path; }
    }));
    return [...new Set([...paths, ...resolved])];
  } catch { throw new RuntimeStop("Could not determine Claude read-only filesystem boundaries."); }
}

/**
 * No inherited tool grants, hooks, MCP servers, settings, slash commands (skills) or auto-memory. Managed policy
 * still applies. Claude keeps the owner's config directory, where its login lives: see the README's engine section.
 */
/**
 * `headedResult` is a headed read-only run's result file (see headed-session.ts). An interactive session never prompts:
 * plan mode would stop at its plan-approval prompt, so it runs in `dontAsk` (anything not allowed is denied), with Bash
 * allowed only inside the same read-only, no-network sandbox and the Write tool allowed only for that one file.
 * Write sessions keep the same flags headed or headless.
 */
export async function claudePermissionArgs(cwd: string, write?: WriteAccess, headedResult?: string): Promise<string[]> {
  const readOnlyHeaded = !write && headedResult !== undefined;
  const resultRules = readOnlyHeaded ? [`Write(/${resolve(headedResult)})`, `Edit(/${resolve(headedResult)})`] : [];
  const settings = {
    disableAllHooks: true, autoMemoryEnabled: false,
    permissions: { disableBypassPermissionsMode: "disable", ...(write ? {} : { disableAutoMode: "disable" }),...(readOnlyHeaded ? { allow: resultRules } : {}) },
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: !!write || readOnlyHeaded, excludedCommands: [],
      filesystem: write ? { allowWrite: write.extraDirs.map((dir) => resolve(dir)) } : { denyWrite: await readOnlyWritePaths(cwd) },
      network: { allowedDomains: write ? ["*"] : [], strictAllowlist: true, allowLocalBinding: false },
    },
  };
  return [
    "--setting-sources", "", "--settings", JSON.stringify(settings),
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--no-chrome",
    // Owner decision: write runs use auto mode, where a classifier approves safe actions instead of prompting
    // (acceptEdits prompted for every Bash command). Read-only runs keep plan/dontAsk for the reviewer contract.
    "--permission-mode", write ? "auto" : readOnlyHeaded ? "dontAsk" : "plan", "--permission-prompts", "none",
    "--tools", write ? "Bash,Read,Glob,Grep,Edit,Write,NotebookEdit" : readOnlyHeaded ? "Bash,Read,Glob,Grep,Write" : "Bash,Read,Glob,Grep",
    ...(write ? write.extraDirs.flatMap((dir) => ["--add-dir", resolve(dir)]) : ["--disallowedTools", readOnlyHeaded ? "Edit,NotebookEdit,Agent,WebFetch,WebSearch" : "Edit,Write,NotebookEdit,Agent,WebFetch,WebSearch"]),
  ];
}
