import { AuthAccessWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import {
  readEnvironmentScopeAccess,
  useEnvironmentScopeAccess,
  type EnvironmentScopeAccess,
} from "../../state/session";
import type { SecretsSender } from "./handoffCopyAuto";
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

/** Only a confirmed grant makes this window the sender: an unanswered session may turn out denied. */
const senderFor = (access: EnvironmentScopeAccess): SecretsSender =>
  access === "granted" ? "here" : access === "denied" ? "source-only" : "unconfirmed";

/** Who can send secrets from the source right now, as this window's session reports it. */
export const secretsSenderNow = (source: EnvironmentId): SecretsSender =>
  senderFor(readEnvironmentScopeAccess(source, AuthAccessWriteScope));

export function useSecretsGate(source: EnvironmentId, sourceLabel: string) {
  const access = useEnvironmentScopeAccess(source, AuthAccessWriteScope);
  const blocked = access === "denied";
  return {
    blocked,
    /** Who the finish text names as able to send what stayed. */
    sender: senderFor(access),
    note: blocked ? secretsSourceOnlyText(sourceLabel) : null,
    clamp: (choice: SecretsChoice) => (blocked ? withoutSecrets(choice) : choice),
  };
}

export {
  approveInput,
  sendSecretsOrWithdraw,
  stagedSecretsText,
  withdrawStagedSecrets,
} from "../../studio/copySecretsPolicy";
