import { useAuth } from "@clerk/react";
import type { ConnectionAttemptError } from "@specweave-studio/client-runtime/connection";
import * as Option from "effect/Option";
import { useEffect, useRef } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useRelayEnvironmentDiscovery } from "../state/environments";
import { relayEnvironmentDiscovery } from "../state/relay";
import { useAtomCommand } from "../state/use-atom-command";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

/** The relay refused this browser's Clerk session when listing its machines. */
export function relaySessionRejected(error: Option.Option<ConnectionAttemptError>): boolean {
  return (
    Option.isSome(error) &&
    error.value._tag === "ConnectionBlockedError" &&
    error.value.reason === "authentication"
  );
}

/**
 * Clerk's session is the one "signed in to Connect" every card reads, but
 * Clerk can keep a session the relay no longer accepts: the account then said
 * signed in while relay-reached machines said signed out. When the relay
 * refuses the session, ask once more with a fresh Clerk token; if it still
 * refuses, sign out of Clerk so every screen shows Sign in.
 */
export function ConnectSessionGuard() {
  const { getToken, signOut } = useAuth();
  const discovery = useRelayEnvironmentDiscovery();
  const refresh = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    label: "Check the SpecWithCode Connect session",
    reportFailure: false,
  });
  const checking = useRef(false);
  const rejected = relaySessionRejected(discovery.error);

  useEffect(() => {
    if (!rejected || discovery.refreshing || checking.current) return;
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
        if (relaySessionRejected(after.error)) {
          console.warn("[studio-cloud] Relay rejected the Connect session; signing out");
          await signOut();
        }
      } finally {
        checking.current = false;
      }
    })();
  }, [rejected, discovery.refreshing, getToken, refresh, signOut]);

  return null;
}
