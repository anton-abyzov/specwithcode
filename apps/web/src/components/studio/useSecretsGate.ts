import { useEffect, useSyncExternalStore } from "react";
import { AuthAccessWriteScope, type EnvironmentId } from "@specweave-studio/contracts";
import {
  readEnvironmentScopeAccess,
  useEnvironmentScopeAccess,
  type EnvironmentScopeAccess,
} from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  askSealedRoute,
  onSealedRoute,
  sealedRouteNow,
  secretsBlocked,
  secretsBlockedText,
  secretsSealed,
} from "../../studio/copySecretsRoute";
import { machineHandoff } from "../../studio/machineHandoff";
import type { SecretsSender } from "./handoffCopyAuto";
import type { SecretsChoice } from "./handoffFolderCopyPending";

/**
 * Sending secret files is as strong as granting the destination access, so the plain way
 * needs access:write on the source: SpecWithCode on that machine itself. A window on
 * another machine (signed in through Connect) sends them sealed instead, when the source
 * can reach the destination and that machine takes its secrets (see copySecretsRoute).
 * Where neither works, the rest of the copy runs, the secrets stay on the source, and a
 * note says what sends them.
 */
export const secretsSourceOnlyText = (source: string): string =>
  secretsBlockedText(source, "", null);

/** The choice a window that may not send secrets works with: none travel. */
export const withoutSecrets = (choice: SecretsChoice): SecretsChoice =>
  choice.included ? { included: false, out: choice.out } : choice;

type Destination = EnvironmentId | string | null | undefined;

/**
 * True only when the source answered, this window's grant there lacks access:write, and
 * the source has no sealed way to that destination. Without a destination: no sealed way.
 */
export const secretsBlockedNow = (source: EnvironmentId, destination?: Destination): boolean =>
  secretsBlocked(source, destination);

/** Only a confirmed grant makes this window the sender: an unanswered session may turn out denied. */
const senderFor = (access: EnvironmentScopeAccess, sealed: boolean): SecretsSender =>
  access === "granted" || (access === "denied" && sealed)
    ? "here"
    : access === "denied"
      ? "source-only"
      : "unconfirmed";

/** Who can send secrets from the source right now, as this window's session reports it. */
export const secretsSenderNow = (source: EnvironmentId, destination?: Destination): SecretsSender =>
  senderFor(
    readEnvironmentScopeAccess(source, AuthAccessWriteScope),
    secretsSealed(source, destination),
  );

/**
 * What this window may do with the source's secrets for a copy to `destination`. While the
 * source has not said whether it can send them sealed, the line keeps the person's choice:
 * every approval asks again first and stops at the review when the answer is no.
 */
export function useSecretsGate(
  source: EnvironmentId,
  sourceLabel: string,
  destination: EnvironmentId | null = null,
  destinationLabel = "",
) {
  const access = useEnvironmentScopeAccess(source, AuthAccessWriteScope);
  const ask = useAtomCommand(machineHandoff.copySecretsRoute, { reportFailure: false });
  const denied = access === "denied";
  useEffect(() => {
    if (denied && destination !== null) void askSealedRoute(source, destination, ask);
  }, [ask, denied, destination, source]);
  const route = useSyncExternalStore(onSealedRoute, () => sealedRouteNow(source, destination));
  const asking = denied && destination !== null && route === null;
  const sealed = denied && route?.sealed === true;
  const blocked = denied && !sealed && !asking;
  return {
    blocked,
    /** Secrets go sealed by the source to the destination, not through this window. */
    sealed,
    /** Who the finish text names as able to send what stayed. */
    sender: senderFor(access, sealed),
    note: blocked ? secretsBlockedText(sourceLabel, destinationLabel, route) : null,
    clamp: (choice: SecretsChoice) => (blocked ? withoutSecrets(choice) : choice),
  };
}

export {
  approveInput,
  sendSecretsOrWithdraw,
  stagedSecretsText,
  withdrawStagedSecrets,
} from "../../studio/copySecretsPolicy";
