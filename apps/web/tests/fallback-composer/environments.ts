// The coordinator picker reads its host's providers from the environment store; the
// fixture host answers with the synthetic providers. Every other export is the real one.
import type { EnvironmentId, ServerProvider } from "@specweave-studio/contracts";
import { useEnvironment as useStoredEnvironment } from "../../src/state/environments";
export * from "../../src/state/environments";

let fixture: { id: EnvironmentId; presentation: unknown } | null = null;

export function fixtureEnvironment(id: EnvironmentId, providers: ReadonlyArray<ServerProvider>) {
  fixture = {
    id,
    presentation: {
      environmentId: id,
      label: "This Mac",
      serverConfig: { providers },
      connection: { phase: "connected" },
    },
  };
}

export function useEnvironment(
  environmentId: EnvironmentId | null,
): ReturnType<typeof useStoredEnvironment> {
  const stored = useStoredEnvironment(environmentId);
  return fixture && environmentId === fixture.id
    ? (fixture.presentation as ReturnType<typeof useStoredEnvironment>)
    : stored;
}
