import { AuthAccessWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import { readEnvironmentScopeAccess, useEnvironmentScopeAccess } from "../../state/session";
import type { SecretsChoice } from "./handoffFolderCopyPending";

/**
 * Sending secret files is as strong as granting the destination access, so only a window
 * holding access:write on the source may do it: SpecWithCode on that machine itself. A
 * window on another machine (signed in through Connect) runs the rest of the copy, with
 * secrets left on the source and a note saying where to send them from.
 */
export const secretsSourceOnlyText = (source: string): string =>
  `Only SpecWithCode on ${source} can send secrets. To include them, start this copy in the SpecWithCode window on ${source}.`;

/** The choice a window that may not send secrets works with: none travel. */
export const withoutSecrets = (choice: SecretsChoice): SecretsChoice =>
  choice.included ? { included: false, out: choice.out } : choice;

/** True only when the source answered and this window's grant there lacks access:write. */
export const secretsBlockedNow = (source: EnvironmentId): boolean =>
  readEnvironmentScopeAccess(source, AuthAccessWriteScope) === "denied";

export function useSecretsGate(source: EnvironmentId, sourceLabel: string) {
  const blocked = useEnvironmentScopeAccess(source, AuthAccessWriteScope) === "denied";
  return {
    blocked,
    note: blocked ? secretsSourceOnlyText(sourceLabel) : null,
    clamp: (choice: SecretsChoice) => (blocked ? withoutSecrets(choice) : choice),
  };
}
