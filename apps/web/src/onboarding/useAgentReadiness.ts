import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { serverEnvironment } from "../state/server";
import { summarizeAgentReadiness, type AgentReadiness } from "./agentReadiness.logic";

/** Subscribe to each machine's providers and summarize them as one verdict. */
export function useAgentReadiness(
  machines: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly label: string }>,
): AgentReadiness {
  const readinessAtom = useMemo(
    () =>
      Atom.make((get) =>
        summarizeAgentReadiness(
          machines.map(({ environmentId, label }) => ({
            label,
            providers: get(serverEnvironment.providersValueAtom(environmentId)),
          })),
        ),
      ),
    [machines],
  );
  return useAtomValue(readinessAtom);
}
