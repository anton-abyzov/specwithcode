import type { DesignOwnerInput } from "@specweave-studio/contracts";

import { readPrimaryEnvironmentTarget } from "~/environments/primary/target";

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
