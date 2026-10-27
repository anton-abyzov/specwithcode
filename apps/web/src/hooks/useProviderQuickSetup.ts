import { useAtomValue } from "@effect/atom-react";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
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
  REGISTRY_INSTALLER_BY_DRIVER,
  withInstalledBinary,
  type MachineProviders,
  type ProviderElsewhere,
} from "../providerQuickSetup";
import { isThisMachineTarget } from "../connection/desktopLocal";
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

/** What Turn on here is doing right now, shown in the provider's row. */
export type TurnOnStep = "saving" | "installing" | "checking";

const machineLabelAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): string =>
      get(environmentPresentations.presentationsAtom).get(environmentId)?.entry.target.label ??
      "this machine",
  ).pipe(Atom.withLabel(`web-provider-quick-setup:label:${environmentId}`)),
);

// Remote means the chat's machine is not the one this client runs on: a phone,
// browser or second computer opening the Mac counts as remote too. Unknown
// machines take the remote route, whose steps work from anywhere.
const remoteMachineAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get): boolean =>
      !isThisMachineTarget(
        get(environmentPresentations.presentationsAtom).get(environmentId)?.entry,
      ),
  ).pipe(Atom.withLabel(`web-provider-quick-setup:remote:${environmentId}`)),
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
  /** The chat's machine, the one Turn on here sets providers up on. */
  readonly machineLabel?: string;
  /** The chat's machine is not the one this app runs on, so its browser logins open elsewhere. */
  readonly remote?: boolean;
  /** The current step of each running Turn on here, by provider identity. */
  readonly steps?: ReadonlyMap<string, TurnOnStep>;
  /** Providers turned on here this session, so their row can report the outcome. */
  readonly turnedOn?: ReadonlyArray<{
    readonly provider: ProviderElsewhere;
    readonly instanceId: ProviderInstanceId;
  }>;
}

const CHECK_ATTEMPTS = 5;
const CHECK_DELAY_MS = 800;

/** The entries of `scope` (one machine), keyed without the scope prefix. */
function onlyScope<V>(collection: ReadonlyMap<string, V>, scope: string): ReadonlyMap<string, V>;
function onlyScope(collection: ReadonlySet<string>, scope: string): ReadonlySet<string>;
function onlyScope<V>(
  collection: ReadonlyMap<string, V> | ReadonlySet<string>,
  scope: string,
): ReadonlyMap<string, V> | ReadonlySet<string> {
  if (collection instanceof Set) {
    return new Set(
      [...collection].flatMap((key) => (key.startsWith(scope) ? [key.slice(scope.length)] : [])),
    );
  }
  const map = collection as ReadonlyMap<string, V>;
  return new Map(
    [...map].flatMap(([key, value]) =>
      key.startsWith(scope) ? [[key.slice(scope.length), value] as const] : [],
    ),
  );
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
  const machineLabel = useAtomValue(machineLabelAtom(environmentId));
  const remote = useAtomValue(remoteMachineAtom(environmentId));
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
  const [steps, setSteps] = useState<ReadonlyMap<string, TurnOnStep>>(new Map());
  const [turnedOnAll, setTurnedOn] = useState<
    ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly provider: ProviderElsewhere;
      readonly instanceId: ProviderInstanceId;
    }>
  >([]);
  const running = useRef(new Set<string>());
  // A draft can move to another machine while a setup runs. State is kept per
  // machine, so one machine's progress never shows up as another's.
  const scope = `${environmentId}\u0000`;
  const pendingHere = useMemo(() => onlyScope(pending, scope), [pending, scope]);
  const errorsHere = useMemo(() => onlyScope(errors, scope), [errors, scope]);
  const stepsHere = useMemo(() => onlyScope(steps, scope), [steps, scope]);
  const turnedOn = useMemo(
    () => turnedOnAll.filter((item) => item.environmentId === environmentId),
    [turnedOnAll, environmentId],
  );

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
    async (unscopedKey: string, work: () => Promise<string | null>) => {
      const key = `${environmentId}\u0000${unscopedKey}`;
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
      setSteps((previous) => {
        const next = new Map(previous);
        next.delete(key);
        return next;
      });
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
      const key = provider.identity;
      const step = (next: TurnOnStep) =>
        setSteps((previous) => new Map(previous).set(`${environmentId}\u0000${key}`, next));
      void run(key, async () => {
        const plan = planEnableHere(provider, settings);
        const save = async (instance: typeof plan.instance) => {
          const { providerInstances: _instances, ...patch } = buildProviderInstanceUpdatePatch({
            settings,
            instanceId: plan.instanceId,
            instance,
            driver: instance.driver,
            isDefault: plan.isDefault,
          });
          return persist({
            environmentId,
            input: {
              patch,
              providerInstanceMutation: { ...plan.mutation, instance } as typeof plan.mutation,
            },
          });
        };
        // The machine applies saved settings a moment after the save returns,
        // so a refresh can still answer for the instance as it was. Only an
        // enabled snapshot of this instance says what it needs.
        const check = async (): Promise<ServerProvider | string> => {
          step("checking");
          for (let attempt = 0; attempt < CHECK_ATTEMPTS; attempt += 1) {
            if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, CHECK_DELAY_MS));
            const refreshed = await refresh({
              environmentId,
              input: { instanceId: plan.instanceId, refreshModels: true },
            });
            if (refreshed._tag === "Failure")
              return (
                failureMessage(refreshed, "The machine did not answer the provider check.") ??
                "The machine did not answer the provider check."
              );
            const snapshot = refreshed.value.providers.find(
              (entry) => entry.instanceId === plan.instanceId,
            );
            if (snapshot?.enabled) return snapshot;
          }
          return `${provider.displayName} was saved, but ${machineLabel} has not reported it as on yet. Check again in a moment.`;
        };
        const remember = () =>
          setTurnedOn((previous) => [
            ...previous.filter(
              (item) => item.environmentId !== environmentId || item.provider.identity !== key,
            ),
            { environmentId, provider, instanceId: plan.instanceId },
          ]);

        step("saving");
        const saved = await save(plan.instance);
        if (saved._tag === "Failure")
          return failureMessage(saved, "The provider could not be turned on here.");
        remember();
        if (plan.prepareAgentId) {
          step("installing");
          const prepared = await prepare({
            environmentId,
            input: { agentId: plan.prepareAgentId },
          });
          if (prepared._tag === "Failure")
            return failureMessage(prepared, "Installation did not finish. Retry.");
          const checked = await check();
          return typeof checked === "string" ? checked : null;
        }
        const snapshot = await check();
        if (typeof snapshot === "string") return snapshot;
        // A built-in driver only runs a CLI the machine already has. When the
        // machine lacks it and a registry package ships that CLI, install the
        // package there and point this machine's instance at it.
        const installerAgentId = REGISTRY_INSTALLER_BY_DRIVER[provider.driverKind];
        if (snapshot.installed || !installerAgentId) return null;
        step("installing");
        const prepared = await prepare({ environmentId, input: { agentId: installerAgentId } });
        if (prepared._tag === "Failure")
          return failureMessage(prepared, "Installation did not finish. Retry.");
        const executablePath = prepared.value.executablePath;
        if (!executablePath)
          return `${provider.displayName} installed, but this machine's SpecWithCode is too old to report where. Update it and retry.`;
        step("saving");
        const pointed = await save(withInstalledBinary(plan.instance, executablePath));
        if (pointed._tag === "Failure")
          return failureMessage(pointed, "The provider could not be turned on here.");
        const checked = await check();
        return typeof checked === "string" ? checked : null;
      });
    },
    [environmentId, machineLabel, persist, prepare, refresh, run, settings],
  );

  return {
    installable,
    elsewhere,
    canManage,
    pending: pendingHere,
    errors: errorsHere,
    install,
    enableHere,
    machineLabel,
    remote,
    steps: stepsHere,
    turnedOn,
  };
}
