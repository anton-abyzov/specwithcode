/**
 * When this machine's own computer-use tools last injected keyboard or pointer
 * input. Such input resets the system idle time with nobody at the machine, so
 * the host power report carries this time and the server ignores the idle
 * reading for 120 s after it (1436 AC-13). Memory only: a restart forgets it.
 *
 * @module agentInputClock
 */
import type { ComputerUseAction } from "@specweave-studio/contracts";

/** Actions that post keyboard or pointer events to the system. */
const INPUT_ACTIONS: ReadonlySet<ComputerUseAction["kind"]> = new Set([
  "click",
  "move",
  "drag",
  "scroll",
  "type",
  "key",
]);

let lastAgentInputAtMs: number | null = null;

/** Stamps the clock before an action that injects input runs. */
export function noteAgentInput(kind: ComputerUseAction["kind"], nowMs: number): void {
  if (!INPUT_ACTIONS.has(kind)) return;
  lastAgentInputAtMs = Math.max(lastAgentInputAtMs ?? 0, nowMs);
}

export function lastAgentInputAt(): number | null {
  return lastAgentInputAtMs;
}

export function __resetAgentInputClockForTests(): void {
  lastAgentInputAtMs = null;
}
