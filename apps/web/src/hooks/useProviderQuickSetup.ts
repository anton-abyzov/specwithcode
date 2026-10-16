import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerSettings,
} from "@specweave-studio/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";

import { buildProviderInstanceUpdatePatch } from "../components/settings/SettingsPanels.logic";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import {
  oneClickInstallAgentId,
  planEnableHere,
  providersOnOtherMachines,
  type MachineProviders,
  type ProviderElsewhere,
} from "../providerQuickSetup";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

/** Every connected machine except `environmentId`, with its configured providers. */
const otherMachineProvidersAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<MachineProviders> => {
    const machines: MachineProviders[] = [];
    for (const [id, presentation] of get(environmentPresentations.presentationsAtom)) {
      if (id === environmentId || presentation.connection.phase !== "connected") continue;
      const providers = get(serverEnvironment.providersValueAtom(id));
      const settings = get(serverEnvironment.settingsValueAtom(id));
      if (!providers || !settings) continue;
      machines.push({
        environmentId: id,
        label: presentation.entry.target.label,
        entries: applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      });
    }
    return machines;
  }).pipe(Atom.withLabel(`web-provider-quick-setup:others:${environmentId}`)),
);

export interface ProviderQuickSetup {
  /** Enabled registry agents here that one Install click makes usable. */
  readonly installable: ReadonlyMap<ProviderInstanceId, string>;
  readonly elsewhere: ReadonlyArray<ProviderElsewhere>;
  readonly canManage: boolean;
  readonly pending: ReadonlySet<string>;
  readonly errors: ReadonlyMap<string, string>;
  readonly install: (instanceId: ProviderInstanceId) => void;
  readonly enableHere: (provider: ProviderElsewhere) => void;
}

function failureMessage(
  result: AtomCommandResult<unknown, unknown>,
  fallback: string,
): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message ? error.message : fallback;
}

/** One-click provider setup for the picker of a chat on `environmentId`. */
export function useProviderQuickSetup(input: {
  readonly environmentId: EnvironmentId;
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly settings: Pick<ServerSettings, "providerInstances" | "providers">;
}): ProviderQuickSetup {
  const { environmentId, entries, settings } = input;
  const others = useAtomValue(otherMachineProvidersAtom(environmentId));
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const prepare = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const persist = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
  });
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const running = useRef(new Set<string>());

  const installable = useMemo(() => {
    const map = new Map<ProviderInstanceId, string>();
    for (const entry of entries) {
      const agentId = oneClickInstallAgentId(entry);
      if (agentId) map.set(entry.instanceId, agentId);
    }
    return map;
  }, [entries]);
  const elsewhere = useMemo(
    () => providersOnOtherMachines({ here: entries, others }),
    [entries, others],
  );

  const run = useCallback(
    async (key: string, work: () => Promise<string | null>) => {
      if (
        running.current.has(key) ||
        !readEnvironmentScope(environmentId, AuthProvidersManageScope)
      )
        return;
      running.current.add(key);
      setPending((previous) => new Set(previous).add(key));
      setErrors((previous) => {
        const next = new Map(previous);
        next.delete(key);
        return next;
      });
      let error: string | null;
      try {
        error = await work();
      } catch {
        error = "Setup could not finish. Check the machine connection and retry.";
      }
      running.current.delete(key);
      setPending((previous) => {
        const next = new Set(previous);
        next.delete(key);
        return next;
      });
      if (error) setErrors((previous) => new Map(previous).set(key, error));
    },
    [environmentId],
  );

  const prepareAndRefresh = useCallback(
    async (agentId: string, instanceId: ProviderInstanceId): Promise<string | null> => {
      const prepared = await prepare({ environmentId, input: { agentId } });
      if (prepared._tag === "Failure")
        return failureMessage(prepared, "Installation did not finish. Retry Install.");
      await refresh({ environmentId, input: { instanceId, refreshModels: true } });
      return null;
    },
    [environmentId, prepare, refresh],
  );

  const install = useCallback(
    (instanceId: ProviderInstanceId) => {
      const agentId = installable.get(instanceId);
      if (!agentId) return;
      void run(instanceId, () => prepareAndRefresh(agentId, instanceId));
    },
    [installable, prepareAndRefresh, run],
  );

  const enableHere = useCallback(
    (provider: ProviderElsewhere) => {
      void run(provider.identity, async () => {
        const plan = planEnableHere(provider, settings);
        const { providerInstances: _instances, ...patch } = buildProviderInstanceUpdatePatch({
          settings,
          instanceId: plan.instanceId,
          instance: plan.instance,
          driver: plan.instance.driver,
          isDefault: plan.isDefault,
        });
        const saved = await persist({
          environmentId,
          input: { patch, providerInstanceMutation: plan.mutation },
        });
        if (saved._tag === "Failure")
          return failureMessage(saved, "The provider could not be turned on here.");
        if (plan.prepareAgentId) return prepareAndRefresh(plan.prepareAgentId, plan.instanceId);
        await refresh({
          environmentId,
          input: { instanceId: plan.instanceId, refreshModels: true },
        });
        return null;
      });
    },
    [environmentId, persist, prepareAndRefresh, refresh, run, settings],
  );

  return { installable, elsewhere, canManage, pending, errors, install, enableHere };
}
