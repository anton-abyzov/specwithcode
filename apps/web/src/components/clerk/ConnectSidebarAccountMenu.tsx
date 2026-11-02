import { useAuth, useClerk, useUser } from "@clerk/react";

import { usePrimaryCloudLinkState } from "../../cloud/primaryCloudLinkState";
import { isElectron } from "../../env";
import { AccountMenu } from "../account/AccountMenu";
import type { ConnectAccount } from "../account/accountMenuModel";
import { toastManager } from "../ui/toast";
import { resolveClerkSignOutRedirectUrl } from "./authRedirect";
import { useStudioConnectAccountPage } from "./StudioConnectAccountPages";
import { useStudioConnectAuthPrompt } from "./useStudioConnectAuthPrompt";

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

  const account: ConnectAccount = !isLoaded
    ? { status: "unavailable" }
    : isSignedIn
      ? {
          status: "signedIn",
          name: user?.fullName ?? null,
          email: user?.primaryEmailAddress?.emailAddress ?? null,
        }
      : { status: "signedOut", linked: link.data?.linked === true };

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
          onSignIn: openAuthPrompt,
          onManage: openAccountPage,
          onSignOut: signOut,
        }}
      />
      {portals}
    </>
  );
}
