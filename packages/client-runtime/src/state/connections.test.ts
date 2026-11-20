import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createEnvironmentCatalogAtoms } from "./connections.ts";

const ENVIRONMENT_ID = EnvironmentId.make("catalog-environment");

const connectionState = (
  overrides: Partial<SupervisorConnectionState>,
): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  ...overrides,
});

const makeCatalogHarness = Effect.fn("TestCatalog.makeHarness")(function* () {
  const state = yield* SubscriptionRef.make(
    connectionState({ phase: "connected", attempt: 1, generation: 1 }),
  );
  const session = yield* SubscriptionRef.make(Option.some({} as RpcSession.RpcSession));
  const supervisor = {
    state,
    session,
  } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const catalog = createEnvironmentCatalogAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
  );
  const atom = catalog.sessionGenerationAtom(ENVIRONMENT_ID);
  const atoms = AtomRegistry.make();
  const unmount = atoms.mount(atom);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      unmount();
      atoms.dispose();
    }),
  );
  yield* Effect.yieldNow;
  /** Moves the supervisor to `next`, with a new session object when one is established. */
  const generationAfter = (
    next: SupervisorConnectionState,
    nextSession: Option.Option<RpcSession.RpcSession> = Option.none(),
  ) =>
    SubscriptionRef.set(session, nextSession).pipe(
      Effect.andThen(SubscriptionRef.set(state, next)),
      Effect.andThen(Effect.yieldNow),
      Effect.map(() => atoms.get(atom)),
    );
  return { generation: () => atoms.get(atom), generationAfter };
});

const lastFailure = new ConnectionTransientError({ reason: "transport", detail: "Down." });
const newSession = () => Option.some({} as RpcSession.RpcSession);

describe("environment catalog atoms", () => {
  it.effect("changes the session generation only when a new session comes up", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { generation, generationAfter } = yield* makeCatalogHarness();
        const first = generation();
        // A retry reports the generation it is attempting before it is established.
        expect(
          yield* generationAfter(
            connectionState({ phase: "connecting", stage: "opening", generation: 2, lastFailure }),
          ),
        ).toBe(first);
        expect(
          yield* generationAfter(
            connectionState({ phase: "backoff", generation: 1, lastFailure, retryAt: 1 }),
          ),
        ).toBe(first);
        expect(
          yield* generationAfter(
            connectionState({ phase: "connected", attempt: 2, generation: 2 }),
            newSession(),
          ),
        ).not.toBe(first);
      }),
    ),
  );

  it.effect("changes when a replaced supervisor's first session reuses an old generation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { generation, generationAfter } = yield* makeCatalogHarness();
        const first = generation();
        yield* generationAfter(
          connectionState({ phase: "backoff", generation: 1, lastFailure, retryAt: 1 }),
        );
        // Re-pairing or editing a route installs a new supervisor, whose counter starts over.
        yield* generationAfter(connectionState({ phase: "available", generation: 0 }));
        expect(
          yield* generationAfter(
            connectionState({ phase: "connected", attempt: 1, generation: 1 }),
            newSession(),
          ),
        ).not.toBe(first);
      }),
    ),
  );
});

describe("environment catalog register (1434)", () => {
  it.effect(
    "a save asked for before an account switch carries the account it was asked under",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const accountScope = yield* SubscriptionRef.make<string | null | undefined>(
            "user_fixture_a",
          );
          const seen: Array<unknown> = [];
          let releaseFirst: () => void = () => {};
          const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
          const registry = EnvironmentRegistry.EnvironmentRegistry.of({
            accountScope,
            register: (_target: unknown, options: unknown) =>
              Effect.promise(async () => {
                if (seen.length === 0) {
                  seen.push(options);
                  await firstHeld;
                  return;
                }
                seen.push(options);
              }),
          } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
          const catalog = createEnvironmentCatalogAtoms(
            Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry)),
          );
          const atoms = AtomRegistry.make();
          yield* Effect.addFinalizer(() => Effect.sync(() => atoms.dispose()));
          atoms.get(catalog.accountScopeValueAtom);
          yield* Effect.yieldNow;

          const target = {} as Parameters<typeof catalog.register.run>[1];
          // One save occupies the catalog lane; a second is asked for under A and
          // waits its turn while the account switches to B.
          const first = catalog.register.run(atoms, target);
          const second = catalog.register.run(atoms, target);
          yield* SubscriptionRef.set(accountScope, "user_fixture_b");
          yield* Effect.yieldNow;
          expect(atoms.get(catalog.accountScopeValueAtom)).toBe("user_fixture_b");
          releaseFirst();
          yield* Effect.promise(() => Promise.all([first, second]));

          expect(seen).toEqual([
            { forAccount: "user_fixture_a" },
            { forAccount: "user_fixture_a" },
          ]);
        }),
      ),
  );
});
