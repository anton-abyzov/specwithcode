import { useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";
import { useMemo } from "react";

import { isThisMachineTarget } from "../../connection/desktopLocal";
import { useTx } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { useMachineNicknames } from "../../studio/machineNickname";
import { useHostDownNotes } from "../../studio/unreachableHosts";
import { signedOutBanner } from "../studio/shell/signedOutBannerModel";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { useStudioConnectAuthPrompt } from "./useStudioConnectAuthPrompt";

/**
 * Says this window is signed out of SpecWithCode Connect, which machines that
 * cuts it off from and what still works, with the sign-in one click away.
 * Shown only once Clerk has loaded and says signed out.
 */
export default function ConnectSignedOutBanner() {
  const { isLoaded, isSignedIn } = useAuth();
  const { openAuthPrompt } = useStudioConnectAuthPrompt();
  const { environments } = useEnvironments();
  const notes = useHostDownNotes();
  const nameOf = useMachineNicknames();
  const tx = useTx();
  const content = useMemo(
    () =>
      signedOutBanner(
        {
          signedOut: isLoaded && !isSignedIn,
          machines: environments.map((environment) => ({
            name: nameOf(environment.environmentId, environment.label),
            needsSignIn: notes.get(environment.environmentId) === "needs-sign-in",
            connected: environment.connection.phase === "connected",
            isThisMachine: isThisMachineTarget(environment.entry),
          })),
        },
        tx,
      ),
    [environments, isLoaded, isSignedIn, nameOf, notes, tx],
  );
  if (content === null) return null;
  return (
    <Alert variant="warning" role="status" data-connect-signed-out="" className="mx-2 mb-2">
      <LogInIcon aria-hidden />
      <AlertTitle>{content.title}</AlertTitle>
      <AlertDescription>{content.body}</AlertDescription>
      <AlertAction>
        <Button size="xs" onClick={openAuthPrompt}>
          {tx("Sign in")}
        </Button>
      </AlertAction>
    </Alert>
  );
}
