import * as Effect from "effect/Effect";

import * as HeldHooks from "../hooks/HeldHooks.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

export const revokeEnvironmentLinkRecord = Effect.fn(
  "relay.api.client.revokeEnvironmentLinkRecord",
)(function* (input: {
  readonly userId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}) {
  const links = yield* EnvironmentLinks.EnvironmentLinks;
  return yield* links.revokeForUser(input);
});

export const unlinkEnvironmentRecord = Effect.fn("relay.api.client.unlinkEnvironmentRecord")(
  function* (input: {
    readonly userId: string;
    readonly environmentId: string;
    /** The stage's tunnel-name namespace, to find this link's held webhook requests. */
    readonly managedEndpointNamespace?: string | undefined;
  }) {
    const links = yield* EnvironmentLinks.EnvironmentLinks;
    const managedEndpointProvider = yield* ManagedEndpointProvider.ManagedEndpointProvider;
    const deprovisionTarget = yield* managedEndpointProvider.prepareDeprovision({
      userId: input.userId,
      environmentId: input.environmentId,
    });
    const link = yield* links.getForUser({
      userId: input.userId,
      environmentId: input.environmentId,
    });
    const unlinked =
      link === null
        ? false
        : yield* revokeEnvironmentLinkRecord({
            userId: input.userId,
            environmentId: link.environmentId,
            environmentPublicKey: link.environmentPublicKey,
          });
    // External teardown cannot share the SQL batch. Run it only after
    // revocation commits so a database failure leaves a fully usable active
    // link. Still run teardown when the link is already revoked, allowing a
    // retry to finish cleanup after an earlier Cloudflare failure.
    const deprovisioned = yield* managedEndpointProvider.deprovision({
      userId: input.userId,
      environmentId: input.environmentId,
      target: deprovisionTarget,
    });
    // Requests held for this link's endpoint go with it. Best effort: the link
    // is already gone, and its inbox drops anything left after its TTL.
    const endpointKey =
      deprovisionTarget && input.managedEndpointNamespace
        ? HeldHooks.endpointKeyForTunnelName(
            input.managedEndpointNamespace,
            deprovisionTarget.tunnelName,
          )
        : null;
    if (endpointKey !== null) {
      const inbox = yield* HookInbox.HookInbox;
      yield* inbox.clear({ endpointKey }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not clear held webhook requests", {
            environmentId: input.environmentId,
            errorTag: error._tag,
          }),
        ),
      );
    }
    if (!deprovisioned) {
      const key = { userId: input.userId, environmentId: input.environmentId };
      const retryTarget = yield* managedEndpointProvider.prepareDeprovision(key);
      if (retryTarget !== null && (yield* links.getForUser(key)) === null) {
        yield* managedEndpointProvider.deprovision({ ...key, target: retryTarget });
      }
    }
    return unlinked;
  },
);
