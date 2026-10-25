import type { DesignOwnerInput } from "@specweave-studio/contracts";

import { isLoopbackHostname, readPrimaryEnvironmentTarget } from "~/environments/primary/target";

import { encodeDesignKey } from "../designKey";

/** Navigation options for the editor route of one design: `router.navigate(designRoute(...))`. */
export function designRoute(owner: DesignOwnerInput, designId: string) {
  return {
    to: "/design/$designKey",
    params: { designKey: encodeDesignKey(owner, designId) },
  } as const;
}

export type DesignRoute = ReturnType<typeof designRoute>;

/** The editor route of one design as a path, for links outside the router. */
export function designPath(owner: DesignOwnerInput, designId: string): string {
  return `/design/${encodeURIComponent(designRoute(owner, designId).params.designKey)}`;
}

/** A link any client signed in to this machine can open. */
export function designLink(owner: DesignOwnerInput, designId: string): string {
  let origin = window.location.origin;
  try {
    origin = readPrimaryEnvironmentTarget()?.target.httpBaseUrl ?? origin;
  } catch {
    // The page's own origin is the server in the browser.
  }
  return new URL(designPath(owner, designId), origin).toString();
}

/**
 * Where a copied design link opens. A loopback link (127.0.0.1, localhost)
 * reaches the server only from the computer it runs on: on a paired device the
 * same address names that device itself, so the link must not promise it.
 */
export function designLinkReach(link: string): {
  readonly loopback: boolean;
  readonly text: string;
} {
  let hostname = "";
  try {
    hostname = new URL(link).hostname;
  } catch {
    // Not a URL: treat it like a loopback link and promise nothing beyond this computer.
    hostname = "localhost";
  }
  return isLoopbackHostname(hostname)
    ? {
        loopback: true,
        text: "This link opens on this computer only. On a paired device, open the design from SpecWithCode there.",
      }
    : { loopback: false, text: "Works on this Mac and your paired devices." };
}
