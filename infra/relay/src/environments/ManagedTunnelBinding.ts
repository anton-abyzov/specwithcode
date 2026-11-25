import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as Layer from "effect/Layer";

const makeClient = (auth: Cloudflare.Tunnel.TunnelAuth) => ({
  ...Cloudflare.Tunnel.readWriteClient(auth),
  /**
   * Rotates the tunnel secret so its connectors cannot come back, then drops
   * the ones still attached. Cloudflare refuses to delete a tunnel with live
   * connectors; account deletion uses this to remove a connected machine's.
   */
  disconnect: Effect.fn("Cloudflare.Tunnel.disconnect")(function* (tunnelId: string) {
    const accountId = yield* auth.accountId;
    const tunnelSecret = yield* Effect.sync(() =>
      Base64.encode(globalThis.crypto.getRandomValues(new Uint8Array(32))),
    );
    yield* auth.authorize(zeroTrust.patchTunnelCloudflared({ accountId, tunnelId, tunnelSecret }));
    yield* auth.authorize(zeroTrust.deleteTunnelCloudflaredConnection({ accountId, tunnelId }));
  }),
});

export type ManagedTunnelClient = ReturnType<typeof makeClient>;

export interface ManagedTunnel extends Alchemy.BindingService<
  ManagedTunnel,
  "StudioRelay.ManagedTunnel",
  () => Effect.Effect<
    ManagedTunnelClient,
    never,
    Cloudflare.Worker | Cloudflare.CloudflareEnvironment
  >
> {}

/** Alchemy's read-write tunnel binding plus `disconnect`, which it does not expose. */
export const ManagedTunnel = Alchemy.BindingService<ManagedTunnel>("StudioRelay.ManagedTunnel");

// Same token id and permission groups as Alchemy's read-write tunnel binding,
// so the Worker keeps its existing scoped token.
export const ManagedTunnelBinding = Layer.effect(
  ManagedTunnel,
  Cloudflare.Tunnel.makeTunnelClient(
    "Cloudflare.Tunnel.ReadWriteTunnel",
    ["Cloudflare Tunnel Read", "Cloudflare Tunnel Write"],
    makeClient,
  ),
);
