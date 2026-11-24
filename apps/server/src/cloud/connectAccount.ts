/**
 * The SpecWithCode Connect account this machine is linked to, read from the
 * stored link (`cloud-linked-user-id`, what `CloudLink.linkState` reads) by
 * services that run below `CloudLink` in the layer graph: the peer route and
 * the linked-sync loop (1448). Three outcomes, so a failed read is never
 * taken for "not linked": a linked Percy seat pauses on `unknown`.
 *
 * @module connectAccount
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CloudLink from "./CloudLink.ts";
import { CLOUD_LINKED_USER_ID } from "./config.ts";

export type ConnectAccount =
  | { readonly status: "linked"; readonly cloudUserId: string }
  | { readonly status: "not_linked" }
  /** The stored link could not be read now; nothing is known either way. */
  | { readonly status: "unknown" };

const fromId = (id: string | null): ConnectAccount => {
  const trimmed = id?.trim() ?? "";
  return trimmed === "" ? { status: "not_linked" } : { status: "linked", cloudUserId: trimmed };
};

/**
 * Reads the account from `CloudLink` when this context has it, else from the
 * stored link through `ServerSecretStore`, else answers `unknown`. Resolved
 * once, when the calling service is built.
 */
export const connectAccountReader: Effect.Effect<Effect.Effect<ConnectAccount>> = Effect.gen(
  function* () {
    const cloudLink = yield* Effect.serviceOption(CloudLink.CloudLink);
    if (Option.isSome(cloudLink))
      return cloudLink.value.linkState().pipe(
        Effect.map((state) => fromId(state.cloudUserId)),
        Effect.orElseSucceed((): ConnectAccount => ({ status: "unknown" })),
      );
    const secrets = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
    if (Option.isNone(secrets)) return Effect.succeed<ConnectAccount>({ status: "unknown" });
    return secrets.value.get(CLOUD_LINKED_USER_ID).pipe(
      Effect.map((stored) =>
        Option.isNone(stored) ? fromId(null) : fromId(new TextDecoder().decode(stored.value)),
      ),
      Effect.orElseSucceed((): ConnectAccount => ({ status: "unknown" })),
    );
  },
);

/** The linked account's id, or null when it is not linked or could not be read. */
export const cloudUserIdOf = (account: ConnectAccount): string | null =>
  account.status === "linked" ? account.cloudUserId : null;
