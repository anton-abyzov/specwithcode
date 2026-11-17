/**
 * Where a copy's message box sends when its main is on another machine. Kept free of UI
 * imports so the hook (`useRouteToMain`) and tests share one rule.
 *
 * @module routeToMain
 */
import { checkoutKeyEnvironmentId } from "./projectCoordinatorMachine";

/** Where a copy's message goes: main's checkout, split from its `environmentId:projectId` key. */
export function routeTarget(
  mainKey: string | null,
): { readonly environmentId: string; readonly projectId: string } | null {
  if (!mainKey) return null;
  const environmentId = checkoutKeyEnvironmentId(mainKey);
  const projectId = mainKey.slice(environmentId.length + 1);
  return environmentId && projectId ? { environmentId, projectId } : null;
}

/**
 * The machines a project page's message box names, from one rule. On a copy whose main is
 * elsewhere (`copyOff`) the coordinator runs on main, so the chip under the box names main;
 * Send names main too while it routes there, and no machine while it cannot. Everywhere
 * else both name the machine being looked at. `send` is never a machine the chip does not
 * name.
 */
export function composerMachines(input: {
  /** The machine of the copy this page shows. */
  readonly viewed: string;
  /** Main's checkout, `environmentId:projectId`; null when this page is not a copy. */
  readonly mainKey: string | null;
  readonly copyOff: boolean;
  /** `canRouteToMain` holds: Send delivers to main's coordinator. */
  readonly routes: boolean;
}): { readonly chip: string; readonly send: string | null } {
  const main = input.copyOff ? routeTarget(input.mainKey)?.environmentId : undefined;
  if (!main) return { chip: input.viewed, send: input.viewed };
  return { chip: main, send: input.routes ? main : null };
}

/**
 * Whether a copy's message box can route to main: only to a main the resolver found live
 * (an active coordinator, never a checkout mid-move or a bare successor reference), while
 * its machine is connected and this window may run work there. Otherwise the box stays off
 * and says where to write.
 */
export function canRouteToMain(input: {
  readonly copyOff: boolean;
  readonly target: { readonly environmentId: string } | null;
  readonly mainLive: boolean;
  readonly mainConnected: boolean;
  readonly mayOperate: boolean;
}): boolean {
  return (
    input.copyOff &&
    input.target !== null &&
    input.mainLive &&
    input.mainConnected &&
    input.mayOperate
  );
}

/** The command id a routed message is sent under, kept while the same text is retried. */
export interface HeldRoute {
  readonly fingerprint: string;
  readonly commandId: string;
}

/**
 * The same text to the same main reuses its command id until main confirms it, so a retry
 * after a lost answer is one message on main, not two (the server dedupes by command id).
 */
export function routedCommand(
  held: HeldRoute | null,
  mainKey: string,
  text: string,
  mint: () => string,
): HeldRoute {
  const fingerprint = JSON.stringify([mainKey, text]);
  return held?.fingerprint === fingerprint ? held : { fingerprint, commandId: mint() };
}

/** A routed message carries text only: files were attached on this machine. */
export const ROUTED_FILES_MESSAGE =
  "Files stay on this machine. Remove them to send the text to main, or open main's page to attach them there.";
