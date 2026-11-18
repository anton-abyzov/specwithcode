import { useAuth, useSession } from "@clerk/react";
import { ManagedRelay, setManagedRelaySession } from "@specweave-studio/client-runtime/relay";
import {
  reportAtomCommandResult,
  settleAsyncResult,
  settlePromise,
} from "@specweave-studio/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { RelayManagedTunnelPolicy } from "@specweave-studio/contracts/relay";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { setConnectAccountState } from "./connectAccountState";
import {
  clearConnectSessionRecord,
  keepsConnectMachinesAtSignOut,
  keptConnectMachinesBelongToAnother,
  readConnectSessionRecord,
  writeConnectSessionRecord,
} from "./connectSessionRecord";
import { ConnectRenewResume } from "./ConnectRenewResume";
import { ConnectRouteReconciler } from "./ConnectRouteReconciler";
import { ConnectSessionGuard } from "./ConnectSessionGuard";
import { resolveRelayClerkTokenOptions } from "./publicConfig";
import { ManagedTunnelPolicyContext } from "./managedTunnelPolicy";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken,
  });
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const { session } = useSession();
  const sessionExpireAt = session?.expireAt?.getTime() ?? null;
  const [accountPolicy, setAccountPolicy] = useState<{
    accountId: string;
    policy: RelayManagedTunnelPolicy | null;
  } | null>(null);
  // Clerk replaces getToken as the session refreshes; the policy belongs to the
  // account, so a new function must not refetch it.
  const getTokenRef = useRef(getToken);
  useEffect(() => {
    getTokenRef.current = getToken;
  }, [getToken]);
  useEffect(() => {
    let cancelled = false;
    setAccountPolicy(null);
    if (isLoaded && isSignedIn && userId) {
      void (async () => {
        try {
          const clerkToken = await getTokenRef.current(resolveRelayClerkTokenOptions());
          if (!clerkToken || cancelled) return;
          const policy = await runtime.runPromise(
            ManagedRelay.ManagedRelayClient.pipe(
              Effect.flatMap((client) => client.getManagedTunnelPolicy({ clerkToken })),
            ),
          );
          if (!cancelled) setAccountPolicy({ accountId: userId, policy });
        } catch {
          // Unknown policy is not a finite cap or an unlimited entitlement.
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [isLoaded, isSignedIn, userId]);
  const removeRelayEnvironments = useAtomCommand(environmentCatalog.removeRelayEnvironments, {
    reportFailure: false,
    reportDefect: false,
  });
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      // Not settled yet: a refusal now is never read as a sign-out (1417).
      setConnectAccountState("unknown");
      return;
    }

    let cancelled = false;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;

    // `keepMachines` after an expiry or a renew (AC-16): the token cache still
    // resets, but the machines reached through Connect stay, to say "Needs sign-in".
    const queueAccountCleanup = (options?: { readonly keepMachines?: boolean }) => {
      const keepMachines = options?.keepMachines === true;
      if (!keepMachines) clearConnectSessionRecord();
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition.then(async () => {
        const results = await Promise.all([
          keepMachines ? Promise.resolve(null) : removeRelayEnvironments(),
          settleAsyncResult(() =>
            runtime.runPromiseExit(
              ManagedRelay.ManagedRelayClient.pipe(
                Effect.flatMap((client) => client.resetTokenCache),
              ),
            ),
          ),
        ]);
        for (const result of results) {
          if (result !== null) reportAtomCommandResult(result, { label: "cloud account cleanup" });
        }
      });
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      setConnectAccountState("signed-out");
      deactivateManagedRelayAuthentication();
      if (previousAccount !== null) {
        void queueAccountCleanup({
          keepMachines: keepsConnectMachinesAtSignOut(
            readConnectSessionRecord(),
            Date.now(),
            previousAccount !== undefined,
          ),
        });
      }
    } else {
      setConnectAccountState("signed-in");
      const tokenProvider = () => getToken(resolveRelayClerkTokenOptions());
      const activateSession = () => {
        if (!cancelled) {
          activateManagedRelayAuthentication(userId, tokenProvider);
        }
      };
      const activateAfterTransition = (transition: Promise<void>) => {
        void (async () => {
          const result = await settlePromise(async () => {
            await transition;
            activateSession();
          });
          reportAtomCommandResult(result, { label: "cloud account activation" });
        })();
      };
      const switchedAccount =
        previousAccount !== undefined && previousAccount !== null && previousAccount !== userId;
      // Machines kept after another account's sign-in ran out go before this one starts.
      if (
        switchedAccount ||
        keptConnectMachinesBelongToAnother(readConnectSessionRecord(), userId)
      ) {
        deactivateManagedRelayAuthentication();
        activateAfterTransition(queueAccountCleanup());
      } else {
        activateAfterTransition(accountTransitionRef.current ?? Promise.resolve());
      }
    }
    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn, removeRelayEnvironments, userId]);

  // After the account effect, which reads the previous record first.
  useEffect(() => {
    if (!isLoaded || !isSignedIn || !userId || sessionExpireAt === null) return;
    const record = readConnectSessionRecord();
    if (
      record?.accountId === userId &&
      record.expireAt === sessionExpireAt &&
      record.renewStartedAt === undefined
    )
      return;
    writeConnectSessionRecord({ accountId: userId, expireAt: sessionExpireAt });
  }, [isLoaded, isSignedIn, sessionExpireAt, userId]);

  useEffect(
    () => () => {
      deactivateManagedRelayAuthentication();
      // A remounted provider settles again before anything says "Needs sign-in".
      setConnectAccountState("unknown");
    },
    [],
  );

  return (
    <ManagedTunnelPolicyContext
      value={isSignedIn && accountPolicy?.accountId === userId ? accountPolicy.policy : null}
    >
      {children}
      {isLoaded && isSignedIn && userId ? <ConnectRouteReconciler key={userId} /> : null}
      {isLoaded && isSignedIn && userId ? <ConnectSessionGuard key={`guard-${userId}`} /> : null}
      {isLoaded && !isSignedIn ? <ConnectRenewResume /> : null}
    </ManagedTunnelPolicyContext>
  );
}
