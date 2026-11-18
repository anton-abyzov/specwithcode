import { useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";
import { useMemo } from "react";

import { isThisMachineTarget } from "../../connection/desktopLocal";
import { useLocale, useTx } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { useMachineNicknames } from "../../studio/machineNickname";
import { useFleetReachableHosts, useHostDownNotes } from "../../studio/unreachableHosts";
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
  const reachable = useFleetReachableHosts();
  const nameOf = useMachineNicknames();
  const tx = useTx();
  const locale = useLocale();
  const content = useMemo(() => {
    const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
    return signedOutBanner(
      {
        signedOut: isLoaded && !isSignedIn,
        machines: environments.map((environment) => ({
          name: nameOf(environment.environmentId, environment.label),
          needsSignIn: notes.get(environment.environmentId) === "needs-sign-in",
          reachableFromMachine: reachable.has(environment.environmentId),
          connected: environment.connection.phase === "connected",
          isThisMachine: isThisMachineTarget(environment.entry),
        })),
      },
      tx,
      (names) => list.format(names),
    );
  }, [environments, isLoaded, isSignedIn, locale, nameOf, notes, reachable, tx]);
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
