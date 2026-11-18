import { useAuth } from "@clerk/react";
import type { ConnectionAttemptError } from "@specweave-studio/client-runtime/connection";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useRelayEnvironmentDiscovery } from "../state/environments";
import { relayEnvironmentDiscovery } from "../state/relay";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

/**
 * The relay refused this browser's Clerk session when listing its machines.
 * A proof this device could not make (its key or a signature) never reached
 * the relay, so it is no refusal of the sign-in (1417, AC-13).
 */
export function relaySessionRejected(error: Option.Option<ConnectionAttemptError>): boolean {
  return (
    Option.isSome(error) &&
    error.value._tag === "ConnectionBlockedError" &&
    error.value.reason === "authentication" &&
    error.value.localProofFailure !== true
  );
}

/** True while the relay refuses this window's sign-in after a fresh token; the banner says so. */
export const connectSessionRejectedAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("connect-session-rejected"),
);

function setConnectSessionRejected(rejected: boolean): void {
  if (appAtomRegistry.get(connectSessionRejectedAtom) !== rejected)
    appAtomRegistry.set(connectSessionRejectedAtom, rejected);
}

/**
 * Clerk's session is the one "signed in to Connect" every card reads, but
 * Clerk can keep a session the relay no longer accepts: the account then said
 * signed in while relay-reached machines said signed out. When the relay
 * refuses the session, ask once more with a fresh Clerk token; if it still
 * refuses, say so with Sign in again (1417, AC-13). Signing out stays the
 * person's choice: a silent sign-out here once looked like a lost sign-in.
 */
export function ConnectSessionGuard() {
  const { getToken } = useAuth();
  const discovery = useRelayEnvironmentDiscovery();
  const refresh = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    label: "Check the SpecWithCode Connect session",
    reportFailure: false,
  });
  const checking = useRef(false);
  const rejected = relaySessionRejected(discovery.error);

  // A listing the relay accepts again ends the report; so does leaving this account.
  useEffect(() => {
    if (!rejected) setConnectSessionRejected(false);
  }, [rejected]);
  useEffect(() => () => setConnectSessionRejected(false), []);

  useEffect(() => {
    if (!rejected || discovery.refreshing || checking.current) return;
    const trigger = Option.getOrNull(discovery.error);
    checking.current = true;
    void (async () => {
      try {
        try {
          await getToken({ ...resolveRelayClerkTokenOptions(), skipCache: true });
        } catch {
          // A failed refresh is answered by the relay check below.
        }
        await refresh();
        const after = appAtomRegistry.get(relayEnvironmentDiscovery.stateValueAtom);
        // Only a refusal from the listing this guard just asked for counts: an
        // offline or unfinished refresh leaves the old error in place.
        if (
          !after.offline &&
          !after.refreshing &&
          relaySessionRejected(after.error) &&
          Option.getOrNull(after.error) !== trigger
        ) {
          console.warn(
            "[studio-cloud] Relay rejected the Connect session; asking to sign in again",
          );
          setConnectSessionRejected(true);
        }
      } finally {
        checking.current = false;
      }
    })();
  }, [rejected, discovery.refreshing, discovery.error, getToken, refresh]);

  return null;
}
