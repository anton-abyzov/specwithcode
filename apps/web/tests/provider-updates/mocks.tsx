import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
export const fixtureProvider = {
  driver: ProviderDriverKind.make("codex"),
  instanceId: ProviderInstanceId.make("codex"),
  version: "0.162.1",
  installed: true,
  enabled: true,
  versionAdvisory: {
    status: "behind_latest",
    canUpdate: true,
    updateCommand: "Staged npm install. Verify before switching new sessions.",
    latestVersion: "0.164.0",
  },
} as ServerProvider;
const machines = ["M4 Max (this machine)", "MacBook Pro M3", "M1 Max", "Anna MacBook Air"];
export const useEnvironments = () => ({
  environments: machines.map((label, index) => ({
    environmentId: EnvironmentId.make(`fixture-${index}`),
    label,
    connection: { phase: index === 2 ? "disconnected" : "connected" },
    serverConfig: { providers: [fixtureProvider] },
  })),
});
export const readEnvironmentScope = (id: string) => id !== "fixture-3";
export const serverEnvironment = { updateProvider: {} };
export const useAtomCommand = () => async (input: { environmentId: string; input: unknown }) => {
  (window as unknown as { updateCalls?: unknown[] }).updateCalls ??= [];
  (window as unknown as { updateCalls: unknown[] }).updateCalls.push(input);
  return {
    _tag: "Success",
    value: {
      providers: [
        {
          ...fixtureProvider,
          version: input.environmentId === "fixture-1" ? "0.162.1" : "0.164.0",
          updateState: {
            status: input.environmentId === "fixture-1" ? "failed" : "succeeded",
            message: "Installer busy. Retry when idle.",
          },
        },
      ],
    },
  };
};
