// Stand-ins for everything the join card reads, driven by the page's query:
//   ?connect=signed-in|signed-out|loading|off|none   SpecWithCode Connect on this machine
//   ?machines=account|mixed|none|offline             which machines there are to list
//   ?grants=loading                                  who can run work here is still being read
import { AuthOrchestrationOperateScope } from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import { useSyncExternalStore } from "react";

const params = new URLSearchParams(location.search);
const connect = params.get("connect") ?? "signed-in";
const machines = params.get("machines") ?? "account";
const HERE = "m5";

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
  label: "Anton's MacBook Pro",
  connection: { phase: "connected" },
};
const account = [
  { environmentId: "m4", label: "Anton's MacBook M4MAX", os: "darwin", availability: "online" },
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

export const isElectron = true;
export const hasCloudPublicConfig = () => connect !== "none";
export const useAuth = () => ({
  isLoaded: connect !== "loading",
  isSignedIn: connect === "signed-in" || connect === "off",
});
export const useUser = () => ({
  user: { primaryEmailAddress: { emailAddress: "anton@example.com" } },
});
export const usePrimaryCloudLinkState = () => ({
  data: { linked: true, managedTunnelActive: connect !== "off" },
});
export const useStudioConnectAuthPrompt = () => ({
  authPrompt: null,
  openAuthPrompt: () => calls.push(["sign-in"]),
});
export const scrollToSettingsTarget = (id: string) => calls.push(["show", id]);
export const useSettingsSearchTargetId = () => params.get("target");

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
  grants = [...grants, { coordinatorEnvironmentId: input.coordinator, expiresAt: null }];
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
