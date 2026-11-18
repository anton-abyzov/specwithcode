import { useEffect } from "react";

import { useStudioConnectAuthPrompt } from "../components/clerk/useStudioConnectAuthPrompt";
import { takeConnectRenewOpen } from "./connectSignInStarted";

/**
 * Finishes Sign in again now (1417, AC-12): its sign-out may reload the
 * window, so the first signed-out render after it opens the sign-in. The note
 * is taken on the first run, so a later render never opens it again. Closing
 * that sign-in leaves the saved machines and the signed-out banner.
 */
export function ConnectRenewResume() {
  const { openRenewAuthPrompt } = useStudioConnectAuthPrompt();
  useEffect(() => {
    if (takeConnectRenewOpen()) openRenewAuthPrompt();
  }, [openRenewAuthPrompt]);
  return null;
}
