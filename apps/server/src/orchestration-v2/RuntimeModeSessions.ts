import type { OrchestrationV2ProviderSession } from "@specweave-studio/contracts";

/** A project choice changes the next turn, never interrupts the active provider. */
export function runtimeModeSessionsToDetach(
  command: { readonly applyOnNextTurn?: boolean | undefined },
  sessions: ReadonlyArray<OrchestrationV2ProviderSession>,
) {
  return command.applyOnNextTurn
    ? []
    : sessions
        .filter((session) => !session.capabilities.sessions.supportsRuntimeModeSwitchInSession)
        .map((session) => session.id);
}
