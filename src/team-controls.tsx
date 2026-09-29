import { createMemo, For, Show, type Accessor } from "solid-js";
import { seatCredentialRequirement } from "./autonomy-ports.js";
import { removalRequest } from "./control-adapters.js";
import { autoModeEnabled, seatStatus } from "./state-domain.js";
import { displayText, type TeamInput, type TerminalUiModel, type UiTeamConfirmation } from "./terminal-ui.js";

export function teamConfirmationText(target: UiTeamConfirmation): string {
  const change = target.change;
  if (change.kind === "mission") return `Save the mission for ${target.teamId}: ${displayText(change.value, 8000)}? y save`;
  if (change.kind === "auto") return change.enabled
    ? `Enable auto mode for ${target.teamId} under the owner's standing policy? Proposals and integration/retro merges still require every existing check. y enable`
    : `Turn auto mode off for ${target.teamId}? The next approval gate will wait for the owner. y turn off`;
  if (change.kind === "remove") return `Remove ${displayText(change.request.expected.displayName)} (@${displayText(change.request.expected.externalIdentities.mattermost.username)}) from ${target.teamId}? Retirement waits for finished or reassigned work. y request removal`;
  const request = change.request;
  return `Add ${displayText(request.displayName)} as ${request.role} to ${target.teamId}? Create Mattermost bot @${request.username} and 1Password item "Mattermost bot - ${request.username}", field "token". y add pending seat`;
}

export function TeamControlInput(props: { input: TeamInput; width: number }) {
  const tail = (value: string) => displayText(value, 8000).slice(-Math.max(20, props.width - 20) * 3);
  return <box flexDirection="column" flexShrink={0}>
    <Show when={props.input.kind === "mission"} fallback={(() => {
      const input = () => props.input.kind === "add" ? props.input : undefined;
      return <>
        <text fg="#E9D5FF">New seat · {input()?.field}</text>
        <text>Name: {tail(input()?.request.displayName ?? "")}{input()?.field === "displayName" ? "▏" : ""}</text>
        <text>Bot username: {tail(input()?.request.username ?? "")}{input()?.field === "username" ? "▏" : ""}</text>
        <text>Role: {input()?.request.role} {input()?.field === "role" ? "(←/→ change)" : ""}</text>
        <text fg="#9CA3AF">Tab next field · Enter review · Esc cancel</text>
      </>;
    })()}>
      <text fg="#E9D5FF" wrapMode="word">Mission: {tail(props.input.kind === "mission" ? props.input.value : "")}▏</text>
      <text fg="#9CA3AF">Backspace edit · Enter review · Esc cancel</text>
    </Show>
  </box>;
}

/** Durable settings and lifecycle state are always reread from indra-state. Availability is separate from policy. */
export function TeamControls(props: { model: TerminalUiModel; revision: Accessor<number> }) {
  const team = createMemo(() => { props.revision(); return props.model.team; });
  const controls = props.model.controls;
  const auto = () => !!team() && autoModeEnabled(team()!);
  return <box flexDirection="column" gap={1} padding={1} flexShrink={0}>
    <text fg="#E9D5FF">OWNER TEAM CONTROLS · {displayText(team()?.displayName)}</text>
    <text wrapMode="word">Mission: {displayText(team()?.mission, 8000) || "Not set · e to edit"}</text>
    <text fg="#67E8F9" wrapMode="word">Auto mode: {auto() ? "ON" : "OFF"}{!team()?.standingPolicy ? " (default)" : ` · policy revision ${team()?.standingPolicy?.revisions.at(-1)?.revision}`}</text>
    <Show when={!controls.autoMode}><text fg="#FDE68A" wrapMode="word">Automation unavailable · approvals wait for the owner.{auto() ? " The persisted policy is on; o turns it off." : " Enabling needs the policy and automation adapter."}</text></Show>
    <text fg="#9CA3AF" wrapMode="word">Owner settings: {controls.settings ? "available" : "unavailable"} · Seat lifecycle: {controls.lifecycle ? "available" : "unavailable"} · Product runner: {controls.available?.product ? "available" : "unavailable"}</text>
    <text fg="#9CA3AF" wrapMode="word">Grooming: {controls.available?.grooming ? "available" : "unavailable"} · Policy: {controls.available?.policy ? "available" : "unavailable"} · Release facts: {controls.available?.releaseFacts ? "available" : "unavailable"} · Next sprint: {controls.available?.nextSprint ? "available" : "unavailable"}</text>
    <For each={team()?.seats ?? []}>{(seat) => {
      const selected = () => { props.revision(); return props.model.seatId === seat.id; };
      const requirement = () => seatCredentialRequirement(removalRequest(team()!, seat.id)!.expected);
      return <box flexDirection="column" flexShrink={0} backgroundColor={selected() ? "#243B53" : "#1F2937"} paddingLeft={1}>
        <text fg={selected() ? "#67E8F9" : "#E5E7EB"} wrapMode="word">{selected() ? "▶ " : "  "}{displayText(seat.displayName)} · {displayText(seat.roles.join(", "))} · {seatStatus(seat)}</text>
        <text fg="#9CA3AF" wrapMode="word">{displayText(seat.id)} · @{displayText(seat.handle)}</text>
        <Show when={seatStatus(seat) === "pending"}>
          <text fg="#FDE68A" wrapMode="word">Create Mattermost bot account: @{displayText(requirement().username)}</text>
          <text fg="#FDE68A" wrapMode="word">1Password item: "{displayText(requirement().item)}" · field: "token"</text>
          <text fg="#9CA3AF" wrapMode="word">{controls.lifecycle ? "Indra verifies the bot credential and starts the seat when it works." : "Activation unavailable until the lifecycle adapter is installed."}</text>
        </Show>
        <Show when={seatStatus(seat) === "retiring"}><text fg="#FDE68A" wrapMode="word">Retiring: waits for work to finish or be reassigned; accepts no new work.</text></Show>
        <Show when={seatStatus(seat) === "retired"}><text fg="#9CA3AF">Retired · identity retained for history.</text></Show>
      </box>;
    }}</For>
    <text fg="#9CA3AF" wrapMode="word">Indra never creates Mattermost accounts. Enter credentials only in 1Password.</text>
  </box>;
}
