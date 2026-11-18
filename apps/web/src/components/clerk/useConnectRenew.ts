import { useAuth, useClerk } from "@clerk/react";

import { clearConnectRenewStarted, markConnectRenewStarted } from "../../cloud/connectSessionRecord";
import { markConnectRenewOpen, takeConnectRenewOpen } from "../../cloud/connectSignInStarted";
import { isElectron } from "../../env";
import { toastManager } from "../ui/toast";
import { resolveClerkSignOutRedirectUrl } from "./authRedirect";

/**
 * Sign in again now (1417, AC-12). Clerk shows no sign-in while a session is
 * active and nothing extends one, so a renew signs out and opens the sign-in
 * again. Both notes are written before the sign-out: the account cleanup it
 * starts reads the first and keeps the saved machines, and the signed-out
 * render after it (often after a reload) reads the second and opens the sign-in.
 */
export function useConnectRenew(): () => void {
  const { userId } = useAuth();
  const clerk = useClerk();
  return () => {
    if (!userId) return;
    markConnectRenewStarted(userId);
    markConnectRenewOpen();
    void clerk
      .signOut({ redirectUrl: resolveClerkSignOutRedirectUrl(window.location.href, isElectron) })
      .catch((cause: unknown) => {
        // Still signed in: a later sign-out by the person must not keep the machines.
        clearConnectRenewStarted(userId);
        takeConnectRenewOpen();
        toastManager.add({
          type: "error",
          title: "Could not start a new sign-in",
          description: cause instanceof Error ? cause.message : "Try again in a moment.",
        });
      });
  };
}
