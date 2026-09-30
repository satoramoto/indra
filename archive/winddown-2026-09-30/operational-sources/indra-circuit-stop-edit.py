from pathlib import Path
r=Path('/Users/ryan/.codex/worktrees/circuit-runtime/indra')
p=r/'src/codex-runtime.ts';s=p.read_text();s=s.replace('signal: controller.signal, env','env');s=s.replace('let tree: Promise<TrackedRun> | undefined; let treeTimer:', 'let ending: Promise<unknown> | undefined;\n    let tree: Promise<TrackedRun> | undefined; let treeTimer:')
a=s.index('      controller.signal.addEventListener("abort", () => {');b=s.index('      let stdoutBytes',a)
s=s[:a]+'''      controller.signal.addEventListener("abort", () => {
        // Snapshot while the launcher is still alive, before its tools can be reparented to init.
        ending ??= tracked.then(async (run) => {
          await run.refresh();
          killTimer = setTimeout(() => {
            try {
              if (ownsProcessGroup && child.pid) process.kill(-child.pid, "SIGKILL");
              else child.kill("SIGKILL");
            } catch { /* already exited */ }
          }, 1000);
          try { child.kill("SIGTERM"); } catch { /* already exited */ }
          await run.end(1000);
        });
      }, { once: true });
''' + s[b:]
s=s.replace('      if (tree) await tree.then((run) => run.end(1000)).catch(() => 0);','      if (ending) await ending.catch(() => 0);\n      else if (tree) await tree.then((run) => run.end(1000)).catch(() => 0);\n      clearTimeout(killTimer);')
p.write_text(s)
p=r/'src/claude-runtime.ts';s=p.read_text();s=s.replace('      let killTimer:', '      let ending: Promise<unknown> | undefined;\n      let killTimer:');s=s.replace('        clearTimeout(timer); signal?', '        clearTimeout(timer); clearTimeout(killTimer); progress.end(); signal?')
s=s.replace('''        // Keep escalation alive even if the parent exits first; its owned descendants can outlive it.
        killTimer = setTimeout(() => stop("SIGKILL"), 1000);
        // Continue bounded collection through shutdown; close fires after the stdout pipe has drained.
        stop("SIGTERM");''','''        // Refresh before signalling: detached tools must be recorded before their parent can exit.
        ending = tree.then(async (run) => {
          await run.refresh();
          killTimer = setTimeout(() => stop("SIGKILL"), 1000);
          stop("SIGTERM");
          await run.end(1000);
        });''')
s=s.replace('void tree.then((run) => run.end(1000)).catch(() => 0).then(() => finish(outcome));','void (ending ?? tree.then((run) => run.end(1000))).catch(() => 0).then(() => finish(outcome));')
p.write_text(s)
# tests wait asynchronous refresh and require timers cleaned after completion
for name in ['codex-runtime','claude-runtime']:
 p=r/f'tests/{name}.test.ts';s=p.read_text();s=s.replace('    expect(child.kill).toHaveBeenCalledWith("SIGTERM");\n    child.close("", null);','    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));\n    child.close("", null);');s=s.replace('  expect(child.kill).toHaveBeenCalledWith("SIGTERM");\n  child.close("", null);','  await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));\n  child.close("", null);')
 if name=='claude-runtime':
  s=s.replace('"escalates for the owned process group even after its parent has exited"', '"cleans escalation timers after tracked descendants have ended"')
  s=s.replace('    expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");','    await vi.advanceTimersByTimeAsync(0);\n    expect(kill).toHaveBeenCalledWith(-12345, "SIGTERM");')
  s=s.replace('    expect(kill).toHaveBeenCalledWith(-12345, "SIGKILL");','    expect(kill).not.toHaveBeenCalledWith(-12345, "SIGKILL");\n    expect(vi.getTimerCount()).toBe(0);')
 p.write_text(s)
