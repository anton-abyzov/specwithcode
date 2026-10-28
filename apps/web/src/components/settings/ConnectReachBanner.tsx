import { useAuth } from "@clerk/react";
import { LogInIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useRelayEnvironmentDiscovery } from "../../state/environments";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

export interface UnreachableMachine {
  readonly environmentId: string;
  readonly label: string;
  /** The machine has a SpecWithCode Connect address on the main machine's list. */
  readonly onConnect: boolean;
}

export function connectReachCopy(
  machines: ReadonlyArray<UnreachableMachine>,
  signedIn: boolean,
  discoveredIds: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): { readonly title: string; readonly description: string; readonly signIn: boolean } | null {
  if (machines.length === 0) return null;
  if (!signedIn) {
    const names = listNames(machines.map((machine) => machine.label));
    return {
      title:
        machines.length === 1 ? `Can't reach ${names}` : `Can't reach ${machines.length} machines`,
      description: `Sign in to SpecWithCode Connect to reach ${machines.length === 1 ? "it" : names} without Tailscale. Tailscale stays as a fallback.`,
      signIn: true,
    };
  }
  // Signed in: machines this account cannot see are not linked to Connect yet.
  const notLinked = machines.filter(
    (machine) => !machine.onConnect && !discoveredIds.has(machine.environmentId),
  );
  if (notLinked.length === 0) return null;
  const names = listNames(notLinked.map((machine) => machine.label));
  return {
    title: `${names} ${notLinked.length === 1 ? "isn't" : "aren't"} on SpecWithCode Connect`,
    description: `On ${notLinked.length === 1 ? "that machine" : "each of them"}, open Settings > Connections > SpecWithCode Connect and link it with your account, or run \`specweave-studio connect link\`. It then connects here on its own.`,
    signIn: false,
  };
}

function listNames(names: ReadonlyArray<string>): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Puts the Connect sign-in where unreachable machines show, not only in the sidebar. */
export function ConnectReachBanner({
  machines,
}: {
  readonly machines: ReadonlyArray<UnreachableMachine>;
}) {
  if (!hasCloudPublicConfig() || machines.length === 0) return null;
  return <ConfiguredConnectReachBanner machines={machines} />;
}

function ConfiguredConnectReachBanner({
  machines,
}: {
  readonly machines: ReadonlyArray<UnreachableMachine>;
}) {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const discovery = useRelayEnvironmentDiscovery();
  const { authPrompt, openAuthPrompt } = useStudioConnectAuthPrompt();
  // Signed in, the "not on Connect" hint needs a loaded list: a failed or
  // offline discovery would otherwise blame every machine.
  if (
    !isLoaded ||
    (isSignedIn && (discovery.refreshing || discovery.error._tag === "Some" || discovery.offline))
  )
    return null;
  const copy = connectReachCopy(machines, isSignedIn === true, discovery.environments);
  if (copy === null) return null;
  return (
    <div className="px-3 pt-3 sm:px-4">
      <Alert variant={copy.signIn ? "warning" : "info"} role="status">
        <AlertTitle>{copy.title}</AlertTitle>
        <AlertDescription>{copy.description}</AlertDescription>
        {copy.signIn ? (
          <AlertAction>
            <Button size="xs" onClick={openAuthPrompt}>
              <LogInIcon className="size-3" />
              Sign in to SpecWithCode Connect
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
      {authPrompt}
    </div>
  );
}
