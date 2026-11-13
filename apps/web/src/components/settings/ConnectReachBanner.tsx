import { useTx } from "../../i18n";
import { useAuth } from "@clerk/react";
import { LinkIcon, LogInIcon } from "lucide-react";

import { requestConnectRoutes } from "../../cloud/connectRoutePlan";
import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { useRelayEnvironmentDiscovery } from "../../state/environments";
import { useMachineNicknames } from "../../studio/machineNickname";
import { useStudioConnectAuthPrompt } from "../clerk/useStudioConnectAuthPrompt";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

export interface UnreachableMachine {
  readonly environmentId: string;
  readonly label: string;
  /** The machine has a SpecWithCode Connect address on the main machine's list. */
  readonly onConnect: boolean;
  /** This window already has a SpecWithCode Connect route for the machine. */
  readonly hasConnectRoute?: boolean;
  /**
   * An old record of a machine that joined again under a new id: the name it
   * goes by now. Linking cannot help such a record, so it is never told to link.
   */
  readonly replacedBy?: string;
}

export interface ConnectReachCopy {
  readonly title: string;
  readonly description: string;
  readonly signIn: boolean;
  /** Machines to give a SpecWithCode Connect route from the banner's button. */
  readonly addRoutes?: ReadonlyArray<UnreachableMachine>;
}

export function connectReachCopy(
  machines: ReadonlyArray<UnreachableMachine>,
  signedIn: boolean,
  discoveredIds: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): ConnectReachCopy | null {
  const current = machines.filter((machine) => machine.replacedBy === undefined);
  const replaced = machines.filter((machine) => machine.replacedBy !== undefined);
  return currentMachinesCopy(current, signedIn, discoveredIds) ?? oldRecordsCopy(replaced);
}

/** Old records only: say the machine is fine and the record can go. */
function oldRecordsCopy(replaced: ReadonlyArray<UnreachableMachine>): ConnectReachCopy | null {
  if (replaced.length === 0) return null;
  const now = [...new Set(replaced.map((machine) => machine.replacedBy ?? machine.label))];
  const one = replaced.length === 1;
  return {
    title: one
      ? `An old record of ${now[0]} can't connect`
      : `${replaced.length} old machine records can't connect`,
    description: `${listNames(now)} joined SpecWithCode again as a new machine and ${now.length === 1 ? "works" : "work"} as before. ${one ? "The old record has" : "The old records have"} nothing to reach; remove ${one ? "it" : "them"} from ${one ? "its card" : "their cards"} below.`,
    signIn: false,
  };
}

function currentMachinesCopy(
  machines: ReadonlyArray<UnreachableMachine>,
  signedIn: boolean,
  discoveredIds: ReadonlySet<string> | ReadonlyMap<string, unknown>,
): ConnectReachCopy | null {
  if (machines.length === 0) return null;
  if (!signedIn) {
    // Fleet work from this machine uses the keys each machine gave it, not this
    // window's sign-in; the sign-in only adds this window's own route.
    if (machines.every((machine) => machine.onConnect)) {
      const names = listNames(machines.map((machine) => machine.label));
      return {
        title: `${names} ${machines.length === 1 ? "is" : "are"} on SpecWithCode Connect`,
        description: `Sign in to SpecWithCode Connect here to open ${machines.length === 1 ? "it" : "them"} from this window. Work this machine sends there does not need this sign-in; it uses the key each machine gave it when it was added.`,
        signIn: true,
      };
    }
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
  const linkHint = `On ${notLinked.length === 1 ? "that machine" : "each of them"}, open Settings > Machines > SpecWithCode Connect and link it with your account, or run \`specweave-studio connect link\`. It then connects here on its own.`;
  // On this account's Connect list, but this window has no Connect route for
  // them (removed here earlier, or not added yet): offer it rather than
  // staying quiet while only other addresses are tried.
  const missingRoute = machines.filter(
    (machine) => machine.hasConnectRoute === false && discoveredIds.has(machine.environmentId),
  );
  if (missingRoute.length > 0) {
    const names = listNames(missingRoute.map((machine) => machine.label));
    const one = missingRoute.length === 1;
    const unlinked =
      notLinked.length === 0
        ? ""
        : ` ${listNames(notLinked.map((machine) => machine.label))} ${notLinked.length === 1 ? "isn't" : "aren't"} on SpecWithCode Connect yet. ${linkHint}`;
    return {
      title: `${names} ${one ? "is" : "are"} on SpecWithCode Connect`,
      description: `This window doesn't use SpecWithCode Connect for ${one ? "it" : "them"} yet, so only other addresses are tried. Use Connect to reach ${one ? "it" : "them"} here; Tailscale stays as a fallback.${unlinked}`,
      signIn: false,
      addRoutes: missingRoute,
    };
  }
  if (notLinked.length === 0) return null;
  const names = listNames(notLinked.map((machine) => machine.label));
  return {
    title: `${names} ${notLinked.length === 1 ? "isn't" : "aren't"} on SpecWithCode Connect`,
    description: linkHint,
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
  const tx = useTx();
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const discovery = useRelayEnvironmentDiscovery();
  const nickname = useMachineNicknames();
  const { authPrompt, openAuthPrompt } = useStudioConnectAuthPrompt();
  const namedMachines = machines.map((machine) => ({
    ...machine,
    label: nickname(machine.environmentId, machine.label),
  }));
  // Signed in, the "not on Connect" hint needs a loaded list: a failed or
  // offline discovery would otherwise blame every machine.
  if (
    !isLoaded ||
    (isSignedIn && (discovery.refreshing || discovery.error._tag === "Some" || discovery.offline))
  )
    return null;
  const copy = connectReachCopy(namedMachines, isSignedIn === true, discovery.environments);
  if (copy === null) return null;
  const addRoutes = copy.addRoutes;
  return (
    <div className="px-3 pt-3 sm:px-4">
      <Alert variant={copy.signIn ? "warning" : "info"} role="status">
        <AlertTitle>{copy.title}</AlertTitle>
        <AlertDescription>{copy.description}</AlertDescription>
        {copy.signIn ? (
          <AlertAction>
            <Button size="xs" onClick={openAuthPrompt}>
              <LogInIcon className="size-3" />
              {tx("Sign in to SpecWithCode Connect")}
            </Button>
          </AlertAction>
        ) : addRoutes ? (
          <AlertAction>
            <Button
              size="xs"
              onClick={() =>
                requestConnectRoutes(addRoutes.map((machine) => machine.environmentId))
              }
            >
              <LinkIcon className="size-3" />
              {tx("Use SpecWithCode Connect")}
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
      {authPrompt}
    </div>
  );
}
