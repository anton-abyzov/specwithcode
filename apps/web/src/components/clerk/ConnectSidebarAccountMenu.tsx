import { useAuth, useClerk, useUser } from "@clerk/react";
import { useEffect, useState } from "react";

import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { isElectron } from "../../env";
import { AccountMenu } from "../account/AccountMenu";
import type { ConnectAccount } from "../account/accountMenuModel";
import { toastManager } from "../ui/toast";
import { resolveClerkSignOutRedirectUrl } from "./authRedirect";
import { useStudioConnectAccountPage } from "./StudioConnectAccountPages";
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

  const [loadStalled, setLoadStalled] = useState(false);
  useEffect(() => {
    setLoadStalled(false);
    if (isLoaded) return;
    const timer = setTimeout(() => setLoadStalled(true), CLERK_LOAD_GRACE_MS);
    return () => clearTimeout(timer);
  }, [isLoaded]);

  const linked = link.data?.linked === true;
  const account: ConnectAccount = !isLoaded
    ? loadStalled
      ? { status: "notLoaded", linked }
      : { status: "loading" }
    : isSignedIn
      ? {
          status: "signedIn",
          name: user?.fullName ?? null,
          email: user?.primaryEmailAddress?.emailAddress ?? null,
        }
      : { status: "signedOut", linked };

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
          onSignIn:
            account.status === "notLoaded" ? () => window.location.reload() : openAuthPrompt,
          onManage: openAccountPage,
          onSignOut: signOut,
        }}
      />
      {portals}
    </>
  );
}
