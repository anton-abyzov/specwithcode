import { useAuth } from "@clerk/react";
import { ClockAlertIcon, LogInIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { machinesDependingOnConnectSignIn } from "../../cloud/connectSessionEnd";
import { isThisMachineTarget } from "../../connection/desktopLocal";
import { useLocale, useTx } from "../../i18n";
import { useEnvironments } from "../../state/environments";
import { useMachineNicknames } from "../../studio/machineNickname";
import { useFleetReachableHosts, useHostDownNotes } from "../../studio/unreachableHosts";
import { sessionEndingBanner, signedOutBanner } from "../studio/shell/signedOutBannerModel";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { useConnectRenew } from "./useConnectRenew";
import { useConnectSessionEnd } from "./useConnectSessionEnd";
import { useStudioConnectAuthPrompt } from "./useStudioConnectAuthPrompt";

/**
 * Says this window is signed out of SpecWithCode Connect, which machines that
 * cuts it off from and what still works, with the sign-in one click away.
 * Shown only once Clerk has loaded and says signed out. While signed in, it
 * warns from 2 hours before Clerk ends the sign-in (AC-11).
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
  const sessionEnd = useConnectSessionEnd();
  const renew = useConnectRenew();
  // "Later" hides the warning for this sign-in until the window reloads.
  const [laterFor, setLaterFor] = useState<number | null>(null);
  const ending = useMemo(() => {
    if (!isLoaded || !isSignedIn || sessionEnd.stage !== "banner" || sessionEnd.expireAt === null)
      return null;
    if (laterFor === sessionEnd.expireAt) return null;
    const list = new Intl.ListFormat(locale, { style: "long", type: "conjunction" });
    const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
    return sessionEndingBanner(
      {
        endsAt: time.format(sessionEnd.expireAt),
        machines: machinesDependingOnConnectSignIn(environments, nameOf),
      },
      tx,
      (names) => list.format(names),
    );
  }, [environments, isLoaded, isSignedIn, laterFor, locale, nameOf, sessionEnd, tx]);
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
  if (ending !== null)
    return (
      <Alert variant="warning" role="status" data-connect-session-ending="" className="mx-2 mb-2">
        <ClockAlertIcon aria-hidden />
        <AlertTitle>{ending.title}</AlertTitle>
        <AlertDescription>{ending.body}</AlertDescription>
        <AlertAction>
          <Button size="xs" onClick={renew}>
            {tx("Sign in again now")}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setLaterFor(sessionEnd.expireAt)}>
            {tx("Later")}
          </Button>
        </AlertAction>
      </Alert>
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
