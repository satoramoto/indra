import { AgentRunError } from "../src/runtime-facts.js";

/** A simulated terminal provider failure with known usage, for workflow recovery tests. */
export function accountedFailure(message: string, usage = { inputTokens: 1, outputTokens: 1 }): AgentRunError {
  return new AgentRunError(message, {
    invocationId: "fixture-terminal-failure", engine: "codex", status: "failed",
    startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    usage, usageComplete: true,
  });
}
