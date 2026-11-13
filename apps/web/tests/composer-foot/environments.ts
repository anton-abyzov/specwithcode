/* Two machines and this device's providers: m4 (this device, the coordinator) and
   linux-mini (the open thread). Every other export is the real one. */
import type { EnvironmentId, ServerProvider } from "@specweave-studio/contracts";
import { useEnvironment as useStoredEnvironment } from "../../src/state/environments";
export * from "../../src/state/environments";

const LABELS: Record<string, string> = { "env-m4": "m4", "env-lm": "linux-mini" };
let providers: ReadonlyArray<ServerProvider> = [];

export function fixtureProviders(list: ReadonlyArray<ServerProvider>) {
  providers = list;
}

export function usePrimaryEnvironmentId() {
  return "env-m4" as EnvironmentId;
}

export function useEnvironment(
  environmentId: EnvironmentId | null | undefined,
): ReturnType<typeof useStoredEnvironment> {
  const stored = useStoredEnvironment(environmentId ?? null);
  if (!environmentId || !(environmentId in LABELS)) return stored;
  return {
    environmentId,
    label: LABELS[environmentId],
    serverConfig: { providers },
    connection: { phase: "connected" },
  } as unknown as ReturnType<typeof useStoredEnvironment>;
}
