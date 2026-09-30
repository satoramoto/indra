# Circuit breakers

Indra accounts for each goal and each Product seat in its runtime directory. Model work, command execution, and automatic repair attempts share durable allowances across phases, lanes, process restarts, and retries. Accounting stays outside the state Git repository. A trip stops new work and cancels active work in that scope; ordinary retries cannot clear it.

Default limits:

| Resource | Allowance |
| --- | --- |
| Tokens per goal or Product scope | 5,000,000 |
| Tokens per model invocation | 1,000,000 |
| Aggregate execution time per scope | 2 hours |
| Execution time per invocation | 30 minutes, or the existing shorter provider timeout |
| Automatic repairs per phase | 3 |
| Automatic repairs per scope | 10 |
| Concurrent model invocations per scope | 4 |

Token totals count input plus output. Cached input and reasoning output are already included in those totals and are not counted again. Live provider reports drive cancellation. Providers report asynchronously, so a call can exceed its allowance by work completed before the next report and during shutdown. Codex rollout files and Claude streams or headed transcripts supply live snapshots. Missing final usage, regressing counters, interrupted accounting, or abandoned reservations fail closed with conservative charges. Limits are bounds on admitted work and observed usage, not an exact provider billing cap.

Execution time is the sum of active invocation time. Concurrent lanes spend it concurrently. Waiting for external CI does not itself spend model tokens. Polling does not consume automatic repair counts. Replaying a cached, finished workflow result invokes no provider and consumes no retry. Repeating an actual model invocation consumes a retry, including when its head and input are unchanged.

Existing work adopts prospective accounting. The ledger explicitly labels earlier usage as unknown; a new ledger's zero recorded usage does not assert that historical work was free.

## Inspect and recover

Run these commands from the owner's terminal in the application checkout:

```sh
node --experimental-ffi dist/cli.js planning budget --goal GOAL_ID --state /path/to/indra-state
node --experimental-ffi dist/cli.js planning budget --seat PRODUCT_SEAT_ID --state /path/to/indra-state
```

The JSON includes totals, limits, active reservations, the current trip, adoption information, and the preserved trip/grant history. Resolve the underlying failure and wait for active invocations to stop before granting additional budget. Grants are an explicit operator action. Agents must not use grants as automatic recovery; the CLI also refuses grants from a hosted agent seat.

```sh
node --experimental-ffi dist/cli.js planning budget-grant --goal GOAL_ID --tokens 250000 --execution-ms 600000 --retries 1 --phase-retries implement=1 --reason 'Fixed the failing command; allow one bounded repair' --state /path/to/indra-state
```

Supply at least one increment and a nonempty reason. Every increment must be a positive finite safe integer. `--phase-retries PHASE=COUNT` may appear once per distinct phase; use the phase names in the ledger's retry records: `implement`, `product`, `vetting`, `planning`, `proposal`, `release`, or `retro`. `--seat PRODUCT_SEAT_ID` targets `product-TEAM_ID-SEAT_ID` instead of a goal. The local OS username records the owner.

Grants add allowances and preserve all totals, retry identifiers, and history. They do not reset accounting, approve a proposal, or queue a retry. A grant that leaves another resource exhausted can leave the circuit tripped. Inspect status again, then explicitly request recovery if appropriate:

```sh
node --experimental-ffi dist/cli.js planning retry --goal GOAL_ID --state /path/to/indra-state
node --experimental-ffi dist/cli.js planning retry --seat PRODUCT_SEAT_ID --state /path/to/indra-state
```

The retry command checks the circuit first. Existing approval, scope, independent review, and CI requirements still apply.

## Configure new scopes

The owner may place a JSON object in `<state-checkout>.runtime/circuit-policy.json` before a scope first runs. Omitted fields use defaults. Supported keys are `maxTokens`, `maxInvocationTokens`, `maxExecutionMs`, `maxInvocationMs`, `maxRetries`, `maxPhaseRetries`, and `maxModelConcurrency`; each must be a positive finite safe integer. Invalid configuration refuses work.

Each scope freezes its policy on adoption. Editing the defaults does not silently increase existing scopes; use a recorded finite grant to extend an existing scope. Keep the runtime ledger and trip marker intact across retries and restarts.
