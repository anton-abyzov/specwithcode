import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import type {
  EnvironmentId,
  FolderCopyApproveInput,
  FolderCopySourceStatus,
} from "@specweave-studio/contracts";
import { secretsBlocked, sourceDeniesSecrets } from "./copySecretsRoute";

/**
 * Which secrets a folder copy may carry, shared by the copy dialog, its background watcher
 * and Add to another machine. Sending secrets the plain way needs access:write on the
 * source; a window without it sends them sealed where the source can (see copySecretsRoute)
 * and otherwise approves with `withoutSecrets`, which the destination enforces.
 */

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
  if (!gate.blocked || !gate.empty) {
    const sent = await commands.send();
    if (sent._tag === "Failure") throw squashAtomCommandFailure(sent);
    return;
  }
  await withdrawStagedSecrets({
    staged: async () => {
      const read = await commands.status().catch(() => null);
      return read?._tag === "Success" && read.value
        ? (read.value.secrets?.files.length ?? 0)
        : null;
    },
    withdraw: async () => (await commands.send())._tag === "Success",
    sourceLabel: gate.sourceLabel,
  });
}

export { sourceDeniesSecrets };

/**
 * The approval for a copy: without secrets when this window can send them in no way (to
 * `destination`, when the copy names one) or the choice leaves them on the source. The
 * destination then pulls none, whatever is staged. Otherwise it names the secret files this
 * window sent (`sent`, empty when it sent none), so the destination pulls exactly those,
 * finishes only with every one of them, and never reads a lost list as a full copy. Null
 * when this window sent no list: the staged one is pulled. `previewRevision` is the one of
 * the preview the person approved from (read before any wait), so a preview another window
 * changed meanwhile is refused; an older destination names none and approves unbound.
 */
export const approveInput = (
  operationId: string,
  source: EnvironmentId,
  included: boolean,
  sent: ReadonlyArray<string> | null = null,
  destination: EnvironmentId | string | null = null,
  previewRevision?: string,
): FolderCopyApproveInput =>
  ({
    ...(secretsBlocked(source, destination) || !included
      ? { operationId, withoutSecrets: true }
      : sent
        ? { operationId, expectedSecrets: [...sent] }
        : { operationId }),
    ...(previewRevision ? { previewRevision } : {}),
  }) as FolderCopyApproveInput;
