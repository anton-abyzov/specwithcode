import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

/**
 * This window's SpecWithCode Connect account as Clerk last settled it (1417).
 * It stays "unknown" until Clerk loads, and always in a build without
 * Connect, so a relay refusal during startup is never read as a sign-out.
 */
export type ConnectAccountState = "unknown" | "signed-in" | "signed-out";

export const connectAccountStateAtom = Atom.make<ConnectAccountState>("unknown").pipe(
  Atom.keepAlive,
  Atom.withLabel("connect-account-state"),
);

export function setConnectAccountState(state: ConnectAccountState): void {
  appAtomRegistry.set(connectAccountStateAtom, state);
}

/**
 * A connection's "needs a Connect sign-in" mark, kept only once Clerk says
 * this window is signed out. While Clerk loads, or while a signed-in session
 * is still being handed to the relay client, the refusal is a startup step,
 * not a sign-out, and the machine keeps its ordinary words.
 */
export function connectSignInShown(
  connectSignInRequired: boolean | undefined,
  account: ConnectAccountState,
): boolean {
  return connectSignInRequired === true && account === "signed-out";
}
