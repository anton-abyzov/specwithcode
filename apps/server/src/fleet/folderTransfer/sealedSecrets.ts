/**
 * Secrets of a folder copy, sent sealed. A window signed in to the source from
 * another machine (through Connect) holds no `access:write` there, so it may
 * not stage secrets the plain way: the transfer token returns to that window,
 * and whoever holds it could pull them. Here the source first asks the copy's
 * own destination machine for a receiving key, over the fleet link, and then
 * serves each secret file only as ciphertext sealed to that key. The window
 * and its token open nothing; the files open on the destination alone.
 *
 * The destination hands out a key only to the machine that offered the copy,
 * and only when that machine is the owner's own with full access there: the
 * bar a secret sent with studio_file_transfer meets.
 */
import {
  FolderCopyError,
  type FolderCopySecretsInput,
  type FolderCopySecretsRoute,
  type FolderCopySourceStatus,
} from "@specweave-studio/contracts";
import * as Context from "effect/Context";

import type { LanControlPeer } from "./lanSource.ts";
import * as Effect from "effect/Effect";

/** The source's line to the destination machine, apart from the window that runs the copy. */
export class SecretsPeer extends Context.Service<
  SecretsPeer,
  {
    /** Whether the machine with that environment id takes this machine's sealed secrets. */
    readonly route: (destinationEnvironmentId: string) => Effect.Effect<FolderCopySecretsRoute>;
    /** That machine's receiving key (base64 SPKI) for one copy it is receiving from here. */
    readonly receivingKey: (input: {
      readonly destinationEnvironmentId: string;
      readonly operationId: string;
    }) => Effect.Effect<string, FolderCopyError>;
    /**
     * The same line, for a copy's local-network offer (`lanCheck`, `lanOffer`). Absent
     * when this server has no fleet link: then no offer is made and the copy uses Connect.
     */
    readonly lan?: LanControlPeer;
  }
>()("specweave-studio/fleet/folderTransfer/sealedSecrets/SecretsPeer") {}

/** No fleet link on this server (a test, or a build without one): nothing travels sealed. */
export const noSecretsPeer = SecretsPeer.of({
  route: () => Effect.succeed({ sealed: false, reason: "not_linked" }),
  receivingKey: () =>
    Effect.fail(
      new FolderCopyError({
        code: "refused",
        detail: "This machine has no link to that machine, so it cannot send it secrets sealed.",
      }),
    ),
});

/** The part of the copy service the sealed path needs. */
export interface SealedSecretsSource {
  /** The destination this copy was offered to; the caller never names it again. */
  readonly copyDestination: (operationId: string) => Effect.Effect<string, FolderCopyError>;
  readonly copySecrets: (
    input: FolderCopySecretsInput,
  ) => Effect.Effect<FolderCopySourceStatus, FolderCopyError>;
  readonly copySecretsSealedTo: (
    input: FolderCopySecretsInput,
    sealTo: string,
  ) => Effect.Effect<FolderCopySourceStatus, FolderCopyError>;
}

/**
 * Stages the ticked secret files sealed to the destination machine's key. The
 * destination is the one saved when the copy was offered. An empty list only
 * withdraws them, which needs no key.
 */
export const stageSealedSecrets = (
  source: SealedSecretsSource,
  peer: SecretsPeer["Service"],
  input: FolderCopySecretsInput,
): Effect.Effect<FolderCopySourceStatus, FolderCopyError> =>
  Effect.gen(function* () {
    if (input.paths.length === 0) return yield* source.copySecrets(input);
    const destinationEnvironmentId = yield* source.copyDestination(input.operationId);
    const sealTo = yield* peer.receivingKey({
      destinationEnvironmentId,
      operationId: input.operationId,
    });
    return yield* source.copySecretsSealedTo(input, sealTo);
  });
