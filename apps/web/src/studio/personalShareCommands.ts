/**
 * The calls behind "Use my Percy on <machine>" (1448 D-12, D-16): the one
 * place the web app names the `personalLink` share RPCs. Each goes to the
 * machine it changes, through that machine's own session, and needs settings
 * write there; the destination checks it again.
 *
 * @module personalShareCommands
 */
import { createEnvironmentRpcCommand } from "@specweave-studio/client-runtime/state/runtime";
import { WS_METHODS } from "@specweave-studio/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

/** Turns the switch on or off and saves the machines confirmed there. */
export const setPersonalSharedCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-share:set",
  tag: WS_METHODS.personalLinkSetShared,
});

/** The machine's part in the account's Percy: members, each machine's state, restore points. */
export const personalShareStatusCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-share:status",
  tag: WS_METHODS.personalLinkShareStatus,
});

/** Puts the machine's Percy back to a restore point and turns the switch off. */
export const undoPersonalShareCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-share:undo",
  tag: WS_METHODS.personalLinkUndo,
});

/** A seat's name and memory file count, for the "Start from" default. */
export const personalLinkPreviewCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "personal-share:preview",
  tag: WS_METHODS.personalLinkPreview,
});
