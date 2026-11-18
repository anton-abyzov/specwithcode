import { useAuth, useClerk, useUser } from "@clerk/react";
import { useEffect, useState } from "react";

import {
  machinesDependingOnConnectSignIn,
  sessionTimeLeft,
} from "../../cloud/connectSessionEnd";
import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { useEnvironments } from "../../state/environments";
import { useMachineNicknames } from "../../studio/machineNickname";
import { useHostDownNotes } from "../../studio/unreachableHosts";
import { isElectron } from "../../env";
import { AccountMenu } from "../account/AccountMenu";
import type { ConnectAccount } from "../account/accountMenuModel";
import { toastManager } from "../ui/toast";
import { resolveClerkSignOutRedirectUrl } from "./authRedirect";
import { useStudioConnectAccountPage } from "./StudioConnectAccountPages";
import { useConnectRenew } from "./useConnectRenew";
import { useConnectSessionEnd } from "./useConnectSessionEnd";
import { useStudioConnectAuthPrompt } from "./useStudioConnectAuthPrompt";

/** Clerk needs the network to start; past this, the window stops saying it is checking. */
const CLERK_LOAD_GRACE_MS = 15_000;

/**
 * Signing in here is this window's account session. A machine stays linked to
 * Connect without it, and fleet work from a main machine never needs it.
 */
export default function ConnectSidebarAccountMenu({ compact }: { readonly compact: boolean }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const clerk = useClerk();
  const { openAuthPrompt } = useStudioConnectAuthPrompt();
  const { open: openAccountPage, portals } = useStudioConnectAccountPage();
  const link = usePrimaryCloudLinkState();
  const renew = useConnectRenew();
  const sessionEnd = useConnectSessionEnd();
  const { environments } = useEnvironments();
  const nameOf = useMachineNicknames();
  // The end matters only while a saved machine is reached through the sign-in (AC-11).
  const sessionEndsIn =
    sessionEnd.stage !== "none" &&
    sessionEnd.expireAt !== null &&
    machinesDependingOnConnectSignIn(environments, nameOf).length > 0
      ? sessionTimeLeft(sessionEnd.expireAt - sessionEnd.now)
      : undefined;

  const [loadStalled, setLoadStalled] = useState(false);
  useEffect(() => {
    setLoadStalled(false);
    if (isLoaded) return;
    const timer = setTimeout(() => setLoadStalled(true), CLERK_LOAD_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isLoaded]);

  const linked = link.data?.linked === true;
  const notes = useHostDownNotes();
  const cutsOff = [...notes.values()].some((note) => note === "needs-sign-in");
  const account: ConnectAccount = !isLoaded
    ? loadStalled
      ? { status: "notLoaded", linked }
      : { status: "loading" }
    : isSignedIn
      ? {
          status: "signedIn",
          name: user?.fullName ?? null,
          email: user?.primaryEmailAddress?.emailAddress ?? null,
          ...(sessionEndsIn === undefined ? {} : { sessionEndsIn }),
        }
      : { status: "signedOut", linked, ...(cutsOff ? { cutsOff: true } : {}) };

  const signOut = () => {
    void clerk
      .signOut({ redirectUrl: resolveClerkSignOutRedirectUrl(window.location.href, isElectron) })
      .catch((cause: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not sign out",
          description: cause instanceof Error ? cause.message : "Try again in a moment.",
        });
      });
  };

  return (
    <>
      <AccountMenu
        compact={compact}
        connect={{
          account,
          // Signed in, the sign-in item is Sign in again now: Clerk shows no
          // sign-in while one is active, so it signs out first (AC-12).
          onSignIn:
            account.status === "notLoaded"
              ? () => window.location.reload()
              : account.status === "signedIn"
                ? renew
                : openAuthPrompt,
          onManage: openAccountPage,
          onSignOut: signOut,
        }}
      />
      {portals}
    </>
  );
}
