import { useAuth, useClerk, useSession } from "@clerk/react";

import {
  clearConnectRenewStarted,
  markConnectRenewStarted,
} from "../../cloud/connectSessionRecord";
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
  const { session } = useSession();
  const clerk = useClerk();
  const expireAt = session?.expireAt?.getTime() ?? null;
  return () => {
    if (!userId) return;
    if (!markConnectRenewStarted(userId, expireAt)) {
      // Signing out now would remove the machines this renew means to keep.
      toastManager.add({
        type: "error",
        title: "Could not start a new sign-in",
        description: "This window could not save its sign-in state. Reload it and try again.",
      });
      return;
    }
    markConnectRenewOpen(userId);
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
