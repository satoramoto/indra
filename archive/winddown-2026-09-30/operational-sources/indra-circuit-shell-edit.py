from pathlib import Path
p=Path('/Users/ryan/.codex/worktrees/circuit-runtime/indra/src/command-shell.ts');s=p.read_text().replace('import { childEnv }','import { ownedProcesses, TREE_REFRESH_MS } from "./process-tree.js";\nimport { childEnv }').replace('export interface Shell { run(command: string, args: string[], cwd: string): Promise<ShellResult> }','export interface ShellOptions { signal?: AbortSignal; timeoutMs?: number }\nexport interface Shell { run(command: string, args: string[], cwd: string, options?: ShellOptions): Promise<ShellResult> }')
a=s.index('  return { run: (command, args, cwd)');b=s.index('\n}\n',a)
s=s[:a]+'''  return { run: async (command, args, cwd, options = {}) => {
    if (options.signal?.aborted) return { code: 1, stdout: "", stderr: "Command cancelled." };
    const timeoutMs = Math.min(options.timeoutMs ?? 2 * 60 * 60_000, 2 * 60 * 60_000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { code: 1, stdout: "", stderr: "Invalid command timeout." };
    let cancelled = false;
    let finish!: (result: ShellResult) => void;
    const result = new Promise<ShellResult>((resolve) => { finish = resolve; });
    // execFile's own timeout kills only its immediate child. Track before signalling so grandchildren cannot escape.
    const child = execFile(command, args, { cwd, encoding: "utf8", maxBuffer: 20_000_000, timeout: 0, detached: process.platform !== "win32", env: envFor(childEnv()) }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      finish({ code: cancelled ? 1 : code, stdout, stderr });
    });
    const tree = ownedProcesses.track(child.pid);
    let ending: Promise<unknown> | undefined;
    const end = () => ending ??= tree.then(async (run) => { await run.refresh(); return run.end(1000); });
    const abort = () => {
      cancelled = true;
      void end().finally(() => { try { child.kill("SIGKILL"); } catch { /* already exited */ } });
    };
    const timer = setTimeout(abort, timeoutMs);
    const refresh = setInterval(() => { void tree.then((run) => run.refresh()); }, TREE_REFRESH_MS);
    refresh.unref?.();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try { return await result; }
    finally {
      clearTimeout(timer); clearInterval(refresh); options.signal?.removeEventListener("abort", abort);
      await end();
    }
  } };''' + s[b:];p.write_text(s)
