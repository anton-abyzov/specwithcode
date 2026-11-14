import type { AtomCommandResult } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  type EnvironmentId,
  type FolderCopySourceStatus,
} from "@specweave-studio/contracts";
import { readEnvironmentScopeAccess, useEnvironmentScopeAccess } from "../../state/session";
import { unwrap, type SecretsChoice } from "./handoffFolderCopyPending";

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

/** What a window that may not send secrets says when it cannot take staged ones off. */
export const stagedSecretsText = (source: string): string =>
  `Secrets are still set to go from ${source}, and this window can't take them off. Untick Secrets in the SpecWithCode window on ${source}, or update SpecWithCode on ${source}, then copy again.`;

/**
 * Before approval, a window that may not send secrets takes off any staged earlier: the
 * destination pulls the staged list when the copy is approved. An empty list needs no
 * access:write. Nothing is sent when the source reports none staged, which keeps older
 * sources (that still gate the empty list) working. Throws when staged ones stay.
 */
export async function withdrawStagedSecrets(input: {
  /** Staged secret files on the source, or null when its status cannot be read. */
  readonly staged: () => Promise<number | null>;
  /** Sends the empty list; true when the source took it. */
  readonly withdraw: () => Promise<boolean>;
  readonly sourceLabel: string;
}): Promise<void> {
  if ((await input.staged()) === 0) return;
  let withdrawn = false;
  try {
    withdrawn = await input.withdraw();
  } catch {
    withdrawn = false;
  }
  if (!withdrawn) throw new Error(stagedSecretsText(input.sourceLabel));
}

/**
 * Sends the copy's secrets list to the source before approval. A window that may not send
 * secrets (its list is always empty) withdraws staged ones instead, as above.
 */
export async function sendSecretsOrWithdraw(
  gate: { readonly blocked: boolean; readonly sourceLabel: string; readonly empty: boolean },
  commands: {
    readonly send: () => Promise<AtomCommandResult<unknown, unknown>>;
    readonly status: () => Promise<AtomCommandResult<FolderCopySourceStatus, unknown>>;
  },
): Promise<void> {
  if (!gate.blocked || !gate.empty) return void unwrap(await commands.send());
  await withdrawStagedSecrets({
    staged: async () => {
      const read = await commands.status();
      return read._tag === "Success" ? (read.value.secrets?.files.length ?? 0) : null;
    },
    withdraw: async () => (await commands.send())._tag === "Success",
    sourceLabel: gate.sourceLabel,
  });
}
