from pathlib import Path
p=Path('src/circuit-scope.ts')
s=p.read_text().replace('import { AsyncLocalStorage }', 'import { createHash } from "node:crypto";\nimport { mkdir, readFile, rename, writeFile } from "node:fs/promises";\nimport { join } from "node:path";\nimport { withFileLock } from "./state-commit.js";\nimport { AsyncLocalStorage }').replace('import { CircuitBudget }','import { CircuitBudget, CircuitOpenError }')
s=s.replace('    if (retry) await budget.chargeRetry(operationId, phase);', '''    await budget.assertAvailable();
    // Count actual starts independently of workflow journals: an interrupted or invalid
    // response cannot get a free repair by replaying the same event or head revision.
    const key = createHash("sha256").update(`${scopeId}:${phase}:${operationId}`).digest("hex");
    const path = join(runtimeDir, `circuit-attempt-${key}.json`);
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    try {
      await withFileLock(`${path}.lock`, async () => {
        let count = 0;
        try { count = JSON.parse(await readFile(path, "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid attempt counter");
        if (retry || count > 0) await budget.chargeRetry(`${key}:${count}`, phase);
        await writeFile(`${path}.tmp`, `${count + 1}\\n`, { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      });
    } catch (error) {
      if (error instanceof CircuitOpenError) throw error;
      throw new CircuitOpenError(scopeId, "invocation attempt accounting unavailable");
    }''')
p.write_text(s)
p=Path('src/planning-bridge.ts');s=p.read_text()
# Narrow public/legacy boundaries own the goal identity while nested phases may override it.
for name,args,call,scope,phase,ret in [
 ('pollGoal','goal: PlanningGoal, own: string','goal, own','goal.id','stageOf(goal)','void'),
 ('integrate','id: string','id','id','"release"','string'),
 ('merge','id: string','id','id','"release"','string'),
 ('rollback','id: string','id','id','"release"','string'),
 ('createSprint','state: PlanningDocument, goal: PlanningGoal','state, goal','goal.id','"implement"','SprintIntegration')]:
 access='private ' if name in ['pollGoal','createSprint'] else ''
 old=f'  {access}async {name}({args}): Promise<{ret}> {{'
 new=f'''  {access}async {name}({args}): Promise<{ret}> {{
    return withCircuitScope(this.store.runtimeDir, {scope}, {phase}, () => this.{name}InScope({call}));
  }}
  private async {name}InScope({args}): Promise<{ret}> {{'''
 assert old in s,name;s=s.replace(old,new)
s=s.replace('return withCircuitScope(this.store.runtimeDir, id, "retro", () => this.ceremonyProgressInScope(id, event));','const goal = (await this.store.read()).planningGoals!.find((item) => item.id === id)!;\n    return withCircuitScope(this.store.runtimeDir, id, stageOf(goal), () => this.ceremonyProgressInScope(id, event));')
# Per-goal scheduler commands, no paid work in global unscoped identity.
s=s.replace('      const context = await (this.scheduler.projectContext?.(home.github) ?? this.github.projectContext(home.github));\n      const baseSha = await this.github.ensureBranch(home.github, goal.id); const at', '      const { context, baseSha } = await withCircuitScope(this.store.runtimeDir, goal.id, "implement", async () => ({\n        context: await (this.scheduler.projectContext?.(home.github) ?? this.github.projectContext(home.github)),\n        baseSha: await this.github.ensureBranch(home.github, goal.id),\n      }));\n      const at')
s=s.replace('metadata.runs.some((item) => !item.finishedAt)', 'drafting && !!metadata.lastDraftError')
s=s.replace('      const reason = "The proposal draft failed; request a retry.";', '      const reason = isCircuitOpen(error) ? error.message : "The proposal draft failed; request a retry.";')
s=s.replace('message: `Drafting the proposal failed; goal ${goal.id} remains in proposal. React', 'message: `${metadata.lastDraftError?.message ?? "Drafting the proposal failed."} Goal ${goal.id} remains in proposal. React')
s=s.replace('import { CircuitBudget, isCircuitOpen }','import { isCircuitOpen }')
p.write_text(s)
p=Path('src/retro-publication.ts');s=p.read_text()
s=s.replace('    if (!record.frozen) {\n      const failures', '    if (!record.frozen) {\n      await new CircuitBudget({ runtimeDir: context.store.runtimeDir, scopeId: context.goal.id }).assertAvailable();\n      const failures')
s=s.replace('      catch (error) {\n        attempt.finishedAt', '      catch (error) {\n        if (isCircuitOpen(error)) throw error;\n        attempt.finishedAt')
s=s.replace('      } catch {\n        record.failure = { at: record.correction.retry.at', '      } catch (error) {\n        if (isCircuitOpen(error)) throw error;\n        record.failure = { at: record.correction.retry.at')
s=s.replace('        const retry = freshDraftRetry(context, record, pr.rejection.submittedAt);','        const retry = freshDraftRetry(context, record, pr.rejection.submittedAt);\n        if (retry) await new CircuitBudget({ runtimeDir: context.store.runtimeDir, scopeId: context.goal.id }).assertAvailable();')
p.write_text(s)
p=Path('src/sprint-retro.ts');s=p.read_text();s='import { isCircuitOpen } from "./circuit-budget.js";\nimport { circuitShell } from "./circuit-scope.js";\nimport { processShell } from "./command-shell.js";\n'+s
s=s.replace('catch (error) { const failed = generationOf(error, false);','catch (error) { if (isCircuitOpen(error)) throw error; const failed = generationOf(error, false);')
old='''    await new Promise<void>((resolve, reject) => {
      execFile("git", ["init", "--quiet", "--template="], { cwd, env: childEnv() }, (error) => error
        ? reject(new RetroGenerationError("Could not prepare the isolated retro workspace.", undefined, "workspace")) : resolve());
    });'''
assert old in s
s=s.replace(old,'''    const initialized = await circuitShell(processShell).run("git", ["init", "--quiet", "--template="], cwd);
    if (initialized.code !== 0) throw new RetroGenerationError("Could not prepare the isolated retro workspace.", undefined, "workspace");''')
p.write_text(s)
p=Path('src/developer-seat.ts');s=p.read_text();s='import { isCircuitOpen } from "./circuit-budget.js";\nimport { circuitRuntime, circuitShell, withCircuitScope } from "./circuit-scope.js";\n'+s
s=s.replace('  ) {}','  ) { this.shell = circuitShell(shell); }',1)
old='  private async work(goal: PlanningGoal, record: SeatTaskRecord, resuming = false): Promise<void> {'
assert old in s
s=s.replace(old,'''  private async work(goal: PlanningGoal, record: SeatTaskRecord, resuming = false): Promise<void> {
    return withCircuitScope(this.store.runtimeDir, goal.id, "implement", () => this.workInScope(goal, record, resuming));
  }
  private async workInScope(goal: PlanningGoal, record: SeatTaskRecord, resuming: boolean): Promise<void> {''')
s=s.replace('this.runtimeFor(record.worktree, write).message(', 'circuitRuntime(this.runtimeFor(record.worktree, write), this.store.runtimeDir, record.goalId, "implement", `legacy:${record.outcomeId}:${role}`, role !== "developer" && role !== "reviewer").message(')
s=s.replace('      this.log(`Agent ${role} session error.`); throw', '      if (isCircuitOpen(error)) throw error;\n      this.log(`Agent ${role} session error.`); throw')
s=s.replace('const reason = error instanceof SeatError || error instanceof ProjectCheckoutError ?', 'const reason = isCircuitOpen(error) || error instanceof SeatError || error instanceof ProjectCheckoutError ?')
p.write_text(s)
