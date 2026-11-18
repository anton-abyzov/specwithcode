/**
 * Where the message box sends when the coordinator is on another machine than the one shown.
 * Kept free of UI imports so the hook (`useRouteToMain`) and tests share one rule.
 *
 * @module routeToMain
 */
import { checkoutKeyEnvironmentId } from "./projectCoordinatorMachine";

/** Where a message goes: the coordinator's checkout, split from its `environmentId:projectId` key. */
export function routeTarget(
  mainKey: string | null,
): { readonly environmentId: string; readonly projectId: string } | null {
  if (!mainKey) return null;
  const environmentId = checkoutKeyEnvironmentId(mainKey);
  const projectId = mainKey.slice(environmentId.length + 1);
  return environmentId && projectId ? { environmentId, projectId } : null;
}

/**
 * The words on the Send button. Never a machine name: where a message goes is said by the
 * line above the box and by the button's tooltip, so the button can never name a machine
 * the chip does not.
 */
export function sendButtonText(input: {
  /** The coordinator's machine has been silent long enough: the button continues it here. */
  readonly continues: boolean;
  /** The draft holds files, which a continued coordinator cannot be sent in the same step. */
  readonly hasFiles: boolean;
}): string {
  if (!input.continues) return "Send";
  return input.hasFiles ? "Continue here" : "Continue here and send";
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
  "Files stay on this machine. Remove them to send the text, or open {project} on {machine} to attach them there.";
