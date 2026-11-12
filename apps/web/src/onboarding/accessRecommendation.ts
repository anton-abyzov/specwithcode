import type { EnvironmentId, RuntimeMode } from "@specweave-studio/contracts";
import { useCallback } from "react";

import {
  persistClientSettingsPatch,
  useClientSettings,
  useClientSettingsHydrated,
} from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { machinesToSwitch } from "./accessRecommendation.logic";

/** The access each machine had before an accept, for Undo. */
export type AcceptedFullAccess = ReadonlyMap<EnvironmentId, RuntimeMode>;

/**
 * The one-time Full access recommendation: the recorded answer and the three
 * ways to answer it. Accept saves `defaultRuntimeMode` on each machine before
 * it records the answer, so a failed save records nothing and can be tried
 * again. Project settings and started chats are never touched.
 */
export function useFullAccessRecommendation() {
  const answer = useClientSettings((settings) => settings.fullAccessRecommendation);
  const machineRole = useClientSettings((settings) => settings.onboardingMachineRole);
  const hydrated = useClientSettingsHydrated();
  const { environments } = useEnvironments();
  const save = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  const writeModes = useCallback(
    async (modes: ReadonlyMap<EnvironmentId, RuntimeMode>) => {
      const results = await Promise.all(
        [...modes].map(([environmentId, mode]) =>
          save({ environmentId, input: { patch: { defaultRuntimeMode: mode } } }),
        ),
      );
      return results.every((result) => result._tag === "Success");
    },
    [save],
  );

  /** Full access for new chats on each machine. Resolves null when a save failed. */
  const accept = useCallback(
    async (environmentIds: readonly EnvironmentId[]): Promise<AcceptedFullAccess | null> => {
      const previous = machinesToSwitch(
        environmentIds.map((id) => ({
          id,
          mode:
            environments.find((environment) => environment.environmentId === id)?.serverConfig
              ?.settings.defaultRuntimeMode ?? null,
        })),
      );
      const fullAccess = new Map([...previous.keys()].map((id) => [id, "full-access" as const]));
      if (!(await writeModes(fullAccess))) return null;
      await persistClientSettingsPatch({ fullAccessRecommendation: "accepted" });
      return previous;
    },
    [environments, writeModes],
  );

  /** Keep the current access; only the answer is saved. */
  const decline = useCallback(
    () => persistClientSettingsPatch({ fullAccessRecommendation: "declined" }),
    [],
  );

  /** Undo an accept: each machine gets its earlier access back, and the answer becomes a decline. */
  const undo = useCallback(
    async (previous: AcceptedFullAccess) => {
      if (!(await writeModes(previous))) return false;
      await persistClientSettingsPatch({ fullAccessRecommendation: "declined" });
      return true;
    },
    [writeModes],
  );

  return { answer, machineRole, hydrated, accept, decline, undo } as const;
}
