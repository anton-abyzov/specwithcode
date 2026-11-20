import { folderCopyLanGateOpen } from "@specweave-studio/contracts";

import { LanDestination, type LanDestinationAccess } from "./lanDestination.ts";
import { systemLanPolicy, type LanPolicy } from "./lanInterfaces.ts";
import { LanSource, type LanControlPeer, type LanSourceAccess } from "./lanSource.ts";

/**
 * How the app builds the local-network path of a folder copy (1390 T-17).
 *
 * The link is the only thing that turns it on. `enabled` is the machine's own
 * stored setting AND the review gate for its operating system; there is no
 * environment variable and no other switch. With it off no key is made, no
 * socket is bound, no `lanCheck` is sent and none is answered with data.
 */
export interface LanLink {
  environmentId: string;
  enabled: boolean;
  /** The authenticated machine-to-machine call; null when this server has no fleet link. */
  peer: LanControlPeer | null;
  updating: () => boolean;
}

export const newLanLink = (): LanLink => ({
  environmentId: "",
  enabled: false,
  peer: null,
  updating: () => false,
});

/** The setting as it takes effect: stored on, and the gate open for this operating system. */
export const lanSettingInEffect = (
  settings: { readonly folderCopyOverLan?: boolean },
  platform: string = process.platform,
): boolean => settings.folderCopyOverLan === true && folderCopyLanGateOpen(platform);

const noRoute = () => Promise.reject(new Error("no_route"));

export function lanHooks(link: LanLink, policy: LanPolicy = systemLanPolicy()) {
  const enabled = () => link.enabled && link.environmentId !== "";
  return {
    source: (access: LanSourceAccess) =>
      new LanSource({
        access,
        environmentId: () => link.environmentId,
        enabled,
        policy,
        updating: () => link.updating(),
        // Without a control route to the destination there is no offer and no listener.
        peer: {
          probe: (destination, body) => link.peer?.probe(destination, body) ?? noRoute(),
          retire: (destination, body) => link.peer?.retire(destination, body) ?? noRoute(),
          check: (destination, body) => link.peer?.check(destination, body) ?? noRoute(),
          offer: (destination, body) => link.peer?.offer(destination, body) ?? noRoute(),
        },
      }),
    destination: (access: LanDestinationAccess) =>
      new LanDestination({ access, environmentId: () => link.environmentId, enabled, policy }),
  };
}
