/**
 * The coordinator conversation's own machine, for the thread chips inside it: a chip names
 * its thread's machine, " · M5", only when that is not the coordinator's (1427 AC-06).
 * Outside a coordinator conversation nothing is set and chips add nothing.
 *
 * @module conversationMachine
 */
import { createContext, useContext } from "react";

import { threadMachineSuffix } from "./machineLabels";
import { machineNickname } from "./machineNickname";

export const ConversationMachineContext = createContext<string | null>(null);

/** A machine's name; "another machine" while only its raw id is known, never the id. */
function knownName(environmentId: string, fallback?: string | null): string {
  const name = machineNickname(environmentId, fallback);
  return name === environmentId ? "another machine" : name;
}

/** The machine a chip adds after its thread's title; null when there is nothing to add. */
export function useThreadChipMachine(
  thread: Parameters<typeof threadMachineSuffix>[0] | null | undefined,
): string | null {
  const coordinatorEnvironmentId = useContext(ConversationMachineContext);
  if (!thread || coordinatorEnvironmentId === null) return null;
  return threadMachineSuffix(thread, coordinatorEnvironmentId, knownName);
}

/** A reply source's machine, known only by its environment; null for the coordinator's own. */
export function sourceMachine(
  coordinatorEnvironmentId: string | null,
  environmentId: string,
): string | null {
  return threadMachineSuffix({ environmentId }, coordinatorEnvironmentId, knownName);
}

/** "Release notes · M5": a relayed message's sender, with its machine when not the coordinator's. */
export function senderWithMachine(
  thread: (Parameters<typeof threadMachineSuffix>[0] & { readonly title: string }) | undefined,
  coordinatorEnvironmentId: string,
): string | null {
  if (!thread) return null;
  const machine = threadMachineSuffix(thread, coordinatorEnvironmentId, knownName);
  return machine && thread.title.trim() ? `${thread.title.trim()} · ${machine}` : thread.title;
}
