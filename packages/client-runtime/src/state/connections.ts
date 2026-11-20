import type { EnvironmentId as EnvironmentIdType } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { AVAILABLE_CONNECTION_STATE, type ConnectionBlockedError } from "../connection/model.ts";
import type * as Persistence from "../platform/persistence.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  GitHubRoutingPermissions,
  type GitHubRoutingPermission,
  type StoredGitHubRoutingPermission,
} from "../connection/githubRoutingPermissions.ts";
import {
  type AtomCommand,
  createAtomCommandScheduler,
  createRuntimeCommand,
  environmentSessionGenerationAtom,
  followStreamInEnvironment,
} from "./runtime.ts";

export interface EnvironmentCatalogState {
  readonly isReady: boolean;
  readonly entries: ReadonlyMap<EnvironmentIdType, ConnectionCatalogEntry>;
}

/**
 * Environments that take part in the workspace: projects, threads, and shell
 * summaries only come from these. Disabled environments stay in `entries` so
 * Settings can list them and switch them back on.
 */
export function* enabledEnvironmentIds(
  catalog: EnvironmentCatalogState,
): Generator<EnvironmentIdType> {
  for (const [environmentId, entry] of catalog.entries) {
    if (entry.enabled) {
      yield environmentId;
    }
  }
}

const EMPTY_ENVIRONMENT_CATALOG_STATE: EnvironmentCatalogState = Object.freeze({
  isReady: false,
  entries: new Map(),
});

export function createEnvironmentCatalogAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const serial = { mode: "serial" as const, key: () => "environment-catalog" };
  const catalogAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) =>
          SubscriptionRef.changes(registry.entries).pipe(
            Stream.map((entries) => ({
              isReady: true,
              entries,
            })),
          ),
        ),
      ),
    ),
    { initialValue: EMPTY_ENVIRONMENT_CATALOG_STATE },
  );

  const catalogValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(catalogAtom)), () => EMPTY_ENVIRONMENT_CATALOG_STATE),
  ).pipe(Atom.withLabel("environment-catalog-value"));

  const githubRoutingPermissionsAtom = runtime.atom(
    Stream.unwrap(GitHubRoutingPermissions.pipe(Effect.map((permissions) => permissions.changes))),
    { initialValue: [] as ReadonlyArray<StoredGitHubRoutingPermission> },
  );
  const githubRoutingPermissionsValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(githubRoutingPermissionsAtom)), () => []),
  ).pipe(Atom.withLabel("environment-github-routing-permissions"));
  const setGitHubRoutingPermission = createRuntimeCommand(runtime, {
    label: "environment-catalog:github-routing-permission",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: Effect.fn(function* (input: {
      readonly environmentId: EnvironmentIdType;
      readonly permission: GitHubRoutingPermission;
    }) {
      const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
      const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
      if (entry === undefined)
        return yield* new EnvironmentRegistry.EnvironmentNotRegisteredError({
          environmentId: input.environmentId,
        });
      const permissions = yield* GitHubRoutingPermissions;
      yield* permissions.set(entry, input.permission);
    }),
  });

  const networkStatusAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) => SubscriptionRef.changes(registry.networkStatus)),
      ),
    ),
    { initialValue: "unknown" as const },
  );

  const networkStatusValueAtom = Atom.make((get) =>
    Option.getOrElse(AsyncResult.value(get(networkStatusAtom)), () => "unknown" as const),
  ).pipe(Atom.withLabel("environment-network-status-value"));

  const stateAtom = Atom.family((environmentId: EnvironmentIdType) =>
    runtime.atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.map((supervisor) => SubscriptionRef.changes(supervisor.state)),
          ),
        ),
      ),
      { initialValue: AVAILABLE_CONNECTION_STATE },
    ),
  );

  const sessionGenerationAtom = (environmentId: EnvironmentIdType) =>
    environmentSessionGenerationAtom(runtime, environmentId);

  const accountScopeAtom = runtime.atom(
    Stream.unwrap(
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.map((registry) => SubscriptionRef.changes(registry.accountScope)),
      ),
    ),
    { initialValue: undefined as string | null | undefined },
  );
  const accountScopeValueAtom = Atom.make((get) =>
    Option.getOrUndefined(AsyncResult.value(get(accountScopeAtom))),
  ).pipe(Atom.keepAlive, Atom.withLabel("environment-account-scope"));
  type RegisterOptions = Parameters<
    EnvironmentRegistry.EnvironmentRegistry["Service"]["register"]
  >[1];
  const registerForAccount = createRuntimeCommand(runtime, {
    label: "environment-catalog:register",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: {
      readonly target: Parameters<
        EnvironmentRegistry.EnvironmentRegistry["Service"]["register"]
      >[0];
      readonly options: RegisterOptions;
    }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.register(input.target, input.options)),
      ),
  });
  // The account is read when the save is asked for, not when it reaches the
  // front of the catalog lane, so a save queued before a switch is refused (1434).
  const register: AtomCommand<
    Parameters<EnvironmentRegistry.EnvironmentRegistry["Service"]["register"]>[0],
    void,
    E | Persistence.ConnectionPersistenceError | ConnectionBlockedError
  > = {
    label: registerForAccount.label,
    run: (atomRegistry, target) => {
      const forAccount = atomRegistry.get(accountScopeValueAtom);
      return registerForAccount.run(atomRegistry, {
        target,
        options: forAccount === undefined ? undefined : { forAccount },
      });
    },
  };
  const remove = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.remove(environmentId)),
      ),
  });
  // Not on the catalog lane: a newer account must reach the registry at once,
  // so removals still running for the previous one stop (1434).
  const setAccount = createRuntimeCommand(runtime, {
    label: "environment-catalog:set-account",
    scheduler: commandScheduler,
    concurrency: { mode: "parallel" },
    execute: (account: string | null) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.setAccount(account)),
      ),
  });
  const removeRelayEnvironments = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove-relay-environments",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (_input: void) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.removeRelayEnvironments()),
      ),
  });
  const setEnabled = createRuntimeCommand(runtime, {
    label: "environment-catalog:set-enabled",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: { readonly environmentId: EnvironmentIdType; readonly enabled: boolean }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.setEnabled(input.environmentId, input.enabled)),
      ),
  });
  const removeRoute = createRuntimeCommand(runtime, {
    label: "environment-catalog:remove-route",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: { readonly environmentId: EnvironmentIdType; readonly routeId: string }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.removeRoute(input.environmentId, input.routeId)),
      ),
  });
  const reorderRoutes = createRuntimeCommand(runtime, {
    label: "environment-catalog:reorder-routes",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (input: {
      readonly environmentId: EnvironmentIdType;
      readonly routeIds: ReadonlyArray<string>;
    }) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.reorderRoutes(input.environmentId, input.routeIds)),
      ),
  });
  const retryNow = createRuntimeCommand(runtime, {
    label: "environment-catalog:retry-now",
    scheduler: commandScheduler,
    concurrency: serial,
    execute: (environmentId: EnvironmentIdType) =>
      EnvironmentRegistry.EnvironmentRegistry.pipe(
        Effect.flatMap((registry) => registry.retryNow(environmentId)),
      ),
  });

  return {
    catalogAtom,
    catalogValueAtom,
    githubRoutingPermissionsValueAtom,
    setGitHubRoutingPermission,
    networkStatusAtom,
    networkStatusValueAtom,
    stateAtom,
    sessionGenerationAtom,
    register,
    remove,
    setAccount,
    accountScopeValueAtom,
    removeRoute,
    reorderRoutes,
    removeRelayEnvironments,
    retryNow,
    setEnabled,
  };
}
