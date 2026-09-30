from pathlib import Path
p=Path('/Users/ryan/.codex/worktrees/circuit-runtime/indra/src/cli.ts');s=p.read_text()
s=s.replace('import { randomUUID } from "node:crypto";', 'import { randomUUID } from "node:crypto";\nimport { userInfo } from "node:os";\nimport { CircuitBudget, CircuitOpenError, type CircuitGrant } from "./circuit-budget.js";')
s=s.replace('"status" | "retry" | GoalAction;', '"status" | "retry" | "budget" | "budget-grant" | GoalAction; grant?: Omit<CircuitGrant, "owner">;')
s=s.replace(' | planning serve|host|status [--state PATH]', ' | planning budget (--goal GOAL_ID | --seat PRODUCT_SEAT_ID) [--state PATH] | planning budget-grant (--goal GOAL_ID | --seat PRODUCT_SEAT_ID) [--tokens N] [--execution-ms N] [--retries N] [--phase-retries PHASE=N] --reason TEXT [--state PATH] | planning serve|host|status [--state PATH]')
s=s.replace('action !== "retry" && !isGoalAction(action)', 'action !== "retry" && action !== "budget" && action !== "budget-grant" && !isGoalAction(action)')
s=s.replace('    const participants: string[] = [];', '    const participants: string[] = [];\n    const grant: Partial<Omit<CircuitGrant, "owner">> = {};\n    const targeted = action === "retry" || action === "budget" || action === "budget-grant";\n    const amount = (value: string): number => {\n      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new StateDataError("Budget increments must be positive finite safe integers.");\n      return Number(value);\n    };')
s=s.replace('else if (key === "--seat" && action === "retry" && !seatId)', 'else if (key === "--seat" && targeted && !seatId)')
s=s.replace('      else if (key === "--participant" && action === "start")', '''      else if (action === "budget-grant" && ["--tokens", "--execution-ms", "--retries"].includes(key)) {
        const field = key === "--tokens" ? "tokens" : key === "--execution-ms" ? "executionMs" : "retries";
        if (grant[field] !== undefined) throw new StateDataError(usage);
        grant[field] = amount(value);
      }
      else if (action === "budget-grant" && key === "--phase-retries") {
        const match = /^([a-zA-Z0-9][a-zA-Z0-9:_.\\/-]{0,255})=([0-9]+)$/.exec(value);
        if (!match || ["constructor", "prototype", "__proto__"].includes(match[1]) || Object.hasOwn(grant.phaseRetries ?? {}, match[1])) throw new StateDataError("Use --phase-retries PHASE=COUNT with a unique phase and positive count.");
        (grant.phaseRetries ??= {})[match[1]] = amount(match[2]);
      }
      else if (action === "budget-grant" && key === "--reason" && grant.reason === undefined && value.trim()) grant.reason = value.trim();
      else if (key === "--participant" && action === "start")''')
s=s.replace('    if (action === "retry" ? !!goal === !!seatId', '    if (targeted ? !!goal === !!seatId')
s=s.replace('    const projectRoot = appRootOf(import.meta.url);\n    return { mode: "planning",', '    if (action === "budget-grant" && (!grant.reason || ![grant.tokens, grant.executionMs, grant.retries, ...Object.values(grant.phaseRetries ?? {})].some((value) => value !== undefined))) throw new StateDataError("A budget grant requires --reason and at least one positive allowance.");\n    const projectRoot = appRootOf(import.meta.url);\n    return { mode: "planning",')
s=s.replace('goal, participants, ...(seatId ?', 'goal, participants, ...(action === "budget-grant" ? { grant: grant as Omit<CircuitGrant, "owner"> } : {}), ...(seatId ?')
s=s.replace('      if (options.action === "retry") {', '''      if (options.action === "budget" || options.action === "budget-grant") {
        let scopeId: string;
        if (options.seatId) {
          const product = await loadProductSeat(store, options.seatId);
          if (!product) throw new StateDataError("A seat budget requires a configured goals-v1 Product seat.");
          scopeId = `product-${product.teamId}-${product.id}`;
        } else {
          const goal = (await store.read()).planningGoals?.find((goal) => goal.id === options.goal);
          if (!goal || goal.workflowModel !== "goals-v1") throw new StateDataError("A budget requires an existing goals-v1 goal.");
          scopeId = goal.id;
        }
        const budget = new CircuitBudget({ runtimeDir: store.runtimeDir, scopeId });
        if (options.action === "budget-grant" && process.env.INDRA_SEAT_PANE === "1") throw new StateDataError("Budget grants belong to the owner terminal, not a hosted agent seat.");
        try {
          const ledger = options.action === "budget" ? await budget.status() : await budget.grant({ ...options.grant!, owner: userInfo().username });
          console.log(JSON.stringify(ledger, null, 2));
          if (options.action === "budget-grant") console.log("Recorded a finite owner allowance. Usage and history are preserved; no retry was queued.");
        } catch (error) { throw new StateDataError(error instanceof Error ? error.message : "Circuit operation failed."); }
        return 0;
      }
      if (options.action === "retry") {''')
s=s.replace('          await new WorkflowInbox(store.runtimeDir).publish({ kind: "product-retry"', '          await new CircuitBudget({ runtimeDir: store.runtimeDir, scopeId: `product-${product.teamId}-${product.id}` }).assertAvailable();\n          await new WorkflowInbox(store.runtimeDir).publish({ kind: "product-retry"')
s=s.replace('        await new WorkflowInbox(store.runtimeDir).publish({ kind: "retry"', '        await new CircuitBudget({ runtimeDir: store.runtimeDir, scopeId: goal.id }).assertAvailable();\n        await new WorkflowInbox(store.runtimeDir).publish({ kind: "retry"')
s=s.replace('    if (error instanceof StateDataError) console.error', '    if (error instanceof CircuitOpenError) console.error(error.message);\n    else if (error instanceof StateDataError) console.error')
p.write_text(s)
