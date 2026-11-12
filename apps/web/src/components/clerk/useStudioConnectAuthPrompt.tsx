import { useClerk } from "@clerk/react";

import {
  type ConnectSignInOrigin,
  markConnectSignInStarted,
} from "../../cloud/connectSignInStarted";
import { isElectron } from "../../env";
import { resolveClerkSignInProps } from "./authRedirect";

export function useStudioConnectAuthPrompt() {
  const clerk = useClerk();
  const open = (origin: ConnectSignInOrigin) => {
    // Signing in through another site reloads this window; the note says a sign-in was under way.
    markConnectSignInStarted(origin);
    clerk.openSignIn(resolveClerkSignInProps(window.location.href, isElectron));
  };
  return {
    authPrompt: null,
    // Takes no argument: it is passed to buttons as their click handler.
    openAuthPrompt: () => open("app"),
    /** For the first-run setup, which links this machine in its own step. */
    openSetupAuthPrompt: () => open("setup"),
  };
}
