// Stand-ins for everything the join card reads, driven by the page's query:
//   ?connect=signed-in|signed-out|loading|off|none   SpecWithCode Connect on this machine
//   ?machines=account|mixed|none|offline             which machines there are to list
//   ?grants=loading                                  who can run work here is still being read
//   ?view=setup                                      the first step of setup around the card
//   ?view=frame                                      a long step in the setup frame, for its footer
//   ?setup=signed-out|linked|failed|off              where that step starts
//   ?linkMs=600                                      how long linking this machine takes
import { AuthOrchestrationOperateScope } from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import { useSyncExternalStore } from "react";

const params = new URLSearchParams(location.search);
const connect = params.get("connect") ?? "signed-in";
const machines = params.get("machines") ?? "account";
const HERE = "m5";
const ACCOUNT = "user_fixture";
const setupView = params.get("view") === "setup";
const setup = params.get("setup") ?? "signed-out";
const linkMs = Number(params.get("linkMs") ?? 600);

interface Saved {
  environmentId: string;
  label: string;
  connection: { phase: string };
  serverConfig?: object;
}
const reported = (os: string, serverVersion: string) => ({
  platform: { os },
  serverVersion,
  capabilities: { fleetAccountJoinWorkers: true },
});
const here: Saved = {
  environmentId: HERE,
  label: "Sam's MacBook Pro",
  connection: { phase: "connected" },
};
const account = [
  { environmentId: "m4", label: "Sam's MacBook M4", os: "darwin", availability: "online" },
  { environmentId: "m1", label: "Mac mini M1", os: "darwin", availability: "online" },
  {
    environmentId: "ms",
    label: "Minisforum",
    os: "linux",
    availability: machines === "offline" ? "offline" : "checking",
  },
] as const;

let saved: ReadonlyArray<Saved> =
  machines === "mixed"
    ? [
        here,
        {
          environmentId: "m3",
          label: "MacBook Air M3",
          connection: { phase: "connected" },
          serverConfig: { environment: reported("darwin", "1.0.243") },
        },
      ]
    : [here];
let grants: ReadonlyArray<object> = [];
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const calls: unknown[] = [];
Object.assign(window, { fixtureCalls: calls });

// Setup starts signed out and not linked unless `setup` says otherwise; the card by
// itself is always on a linked machine.
let signedIn = setupView ? setup !== "signed-out" : connect === "signed-in" || connect === "off";
let link: { data: { linked: boolean; managedTunnelActive: boolean }; error: string | null } = {
  data: setupView
    ? { linked: setup === "linked", managedTunnelActive: setup === "linked" }
    : { linked: true, managedTunnelActive: connect !== "off" },
  error: null,
};
let linkRequests = 0;
// The owner turned Connect off here before: setup must not turn it back on by itself.
const TURNED_OFF_KEY = "studio:connect-turned-off:v1";
if (setupView && setup === "off") {
  localStorage.setItem(TURNED_OFF_KEY, JSON.stringify({ accounts: [ACCOUNT] }));
} else localStorage.removeItem(TURNED_OFF_KEY);

export const isElectron = true;
// The frame's header: no update is waiting and the star link has its own check.
export const FirstRunUpdateNotice = () => null;
export const StarOnGitHubLink = () => null;
export const hasCloudPublicConfig = () => connect !== "none";
export const useAuth = () => ({
  isLoaded: connect !== "loading",
  isSignedIn: useSyncExternalStore(subscribe, () => signedIn),
  userId: ACCOUNT,
});
export const useUser = () => ({
  user: { primaryEmailAddress: { emailAddress: "sam@example.com" } },
});
export const usePrimaryCloudLinkState = () => ({
  data: useSyncExternalStore(subscribe, () => link).data,
});
export const useStudioConnectAuthPrompt = () => ({
  authPrompt: null,
  openAuthPrompt: () => calls.push(["sign-in"]),
  // Setup's sign-in completes at once here, so the step can be watched going on by itself.
  openSetupAuthPrompt: () => {
    calls.push(["sign-in-setup"]);
    signedIn = true;
    changed();
  },
});
export const useCloudLinkController = () => {
  const state = useSyncExternalStore(subscribe, () => link);
  return {
    linkState: { data: state.data, isPending: false, error: null, target: { environmentId: HERE } },
    linked: state.data.linked,
    publishAgentActivity: true,
    operationError: state.error,
    reconcileCloudState: async (desired: object) => {
      calls.push(["link", desired]);
      linkRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, linkMs));
      // `setup=failed`: the first request fails, the owner's Try again works.
      const failed = setup === "failed" && linkRequests === 1;
      link = failed
        ? {
            ...link,
            error: "SpecWithCode Connect did not answer. Check this Mac's internet connection.",
          }
        : { data: { linked: true, managedTunnelActive: true }, error: null };
      changed();
      return !failed;
    },
  };
};
export const environmentSession = { sessionStateAtom: () => ({ _tag: "Success" }) };
export const useAtomValue = (value: unknown) => value;
export const useTeamRules = () => ({ summary: undefined });
export const teamRulesReachLock = () => null;
export const scrollToSettingsTarget = (id: string) => calls.push(["show", id]);
export const useSettingsSearchTargetId = () => params.get("target");
// The card scrolls to itself when a link lands on it; here nothing links to it.
export const useSettingsSearchTarget = () => ({ current: null });

export const useEnvironments = () => ({
  environments: useSyncExternalStore(subscribe, () => saved),
});
const discovered = new Map(
  (machines === "none" || connect === "signed-out" || connect === "loading" || connect === "none"
    ? []
    : account
  ).map((machine) => [
    machine.environmentId,
    {
      environment: { environmentId: machine.environmentId, label: machine.label },
      availability: machine.availability,
      // A machine still being asked has reported nothing yet.
      status:
        machine.availability === "online"
          ? Option.some({ descriptor: reported(machine.os, "1.0.243") })
          : Option.none(),
    },
  ]),
);
export const useRelayEnvironmentDiscovery = () => ({
  environments: discovered,
  refreshing: false,
  offline: false,
});
export const environmentCatalog = { register: "register" };
export const relayEnvironmentDiscovery = { refresh: "refresh" };
export const useAtomCommand =
  (command: string) => async (input?: { target: { environmentId: string; label: string } }) => {
    calls.push([command, input?.target.environmentId]);
    if (command === "register" && input) {
      const found = account.find((machine) => machine.environmentId === input.target.environmentId);
      saved = [
        ...saved,
        {
          environmentId: input.target.environmentId,
          label: input.target.label,
          connection: { phase: "connected" },
          serverConfig: { environment: reported(found?.os ?? "darwin", "1.0.243") },
        },
      ];
      changed();
    }
    return { _tag: "Success" };
  };
// This app manages access here and holds only a SpecWithCode Connect sign-in elsewhere.
export const useEnvironmentScope = (environmentId: string, scope: string) =>
  environmentId === HERE || scope === AuthOrchestrationOperateScope;
export const useMachineNicknames = () => (_id: string, label: string) => label;
export const useMachineWorkGrants = () => ({
  snapshot: useSyncExternalStore(subscribe, () =>
    params.get("grants") === "loading" ? null : grants,
  )
    ? { grants, projects: [], accounts: [] }
    : null,
  loading: params.get("grants") === "loading",
  failed: false,
  refresh: () => calls.push(["refresh-grants"]),
});
export async function requestConfirmDialog(text: string) {
  calls.push(["confirm", text]);
  return true;
}
export async function joinAccountMachineForWorkers(input: { coordinator: string; access: string }) {
  calls.push(["join", input]);
  grants = [
    ...grants,
    {
      coordinatorEnvironmentId: input.coordinator,
      machineLabel:
        account.find((machine) => machine.environmentId === input.coordinator)?.label ??
        input.coordinator,
      status: "active",
      expiresAt: null,
    },
  ];
  changed();
  return {
    id: HERE,
    workers: {
      status: "allowed",
      access: input.access,
      expiresAt: null,
      renewable: true,
      problem: null,
    },
  };
}
export const addVisibleMachineToStudioFleet = async () => ({ id: HERE, environmentId: HERE });
export const allowIncomingStudioFleetWorkers = joinAccountMachineForWorkers;
export const allowStudioFleetWorkers = joinAccountMachineForWorkers;
export const readStudioFleetMachines = async () => [];
