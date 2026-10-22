import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthFilesystemReadScope,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
} from "@specweave-studio/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createDesignAtoms } from "./design.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

it.effect.each([true, false])(
  "reads designs and systems only with the destination's filesystem:read (granted=%s)",
  (granted) =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make(`design-read-${granted}`);
        const calls: string[] = [];
        const designs = { designs: [], problems: [] };
        const systems = { systems: [], problems: [] };
        const answer = (method: string, value: unknown) => () =>
          Effect.sync(() => {
            calls.push(method);
            return value;
          });
        const session = {
          client: {
            [WS_METHODS.designList]: answer(WS_METHODS.designList, designs),
            [WS_METHODS.designSystemList]: answer(WS_METHODS.designSystemList, systems),
          },
        } as unknown as RpcSession;
        const supervisor = EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Fixture",
            httpBaseUrl: "https://fixture.invalid",
            wsBaseUrl: "wss://fixture.invalid",
          }),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected" as const,
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const environments = EnvironmentRegistry.of({
          run: (_id, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
          followStream: (_id, stream) =>
            Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        } as EnvironmentRegistry["Service"]);
        const design = createDesignAtoms(
          Atom.runtime(
            Layer.mergeAll(
              Layer.succeed(EnvironmentRegistry, environments),
              Layer.succeed(
                Crypto.Crypto,
                Crypto.make({
                  randomBytes: (size) => new Uint8Array(size),
                  digest: (_algorithm, data) => Effect.succeed(data),
                }),
              ),
            ),
          ),
        );
        const registry = AtomRegistry.make();
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
        registry.mount(sessions(environmentId));
        registry.set(
          sessions(environmentId),
          AsyncResult.success({
            authenticated: true,
            auth: {
              policy: "remote-reachable",
              bootstrapMethods: [],
              sessionMethods: [],
              sessionCookieName: "test",
            },
            scopes: granted ? [AuthFilesystemReadScope] : [],
            permissions: granted ? [AuthFilesystemReadScope] : [],
          }),
        );
        const filter = { filter: { kind: "all" } } as const;
        const listAtom = design.list({ environmentId, input: filter });
        const systemListAtom = design.systemList({ environmentId, input: filter });
        registry.mount(listAtom);
        registry.mount(systemListAtom);
        const list = AtomRegistry.getResult(registry, listAtom, { suspendOnWaiting: true });
        const systemList = AtomRegistry.getResult(registry, systemListAtom, {
          suspendOnWaiting: true,
        });
        if (granted) {
          expect(yield* list).toEqual(designs);
          expect(yield* systemList).toEqual(systems);
          expect(calls.toSorted()).toEqual([WS_METHODS.designList, WS_METHODS.designSystemList]);
        } else {
          // The guarded state: an authorization failure the UI shows as locked, and no request.
          const denied = {
            _tag: "EnvironmentAuthorizationError",
            message: "This connection requires filesystem:read.",
          };
          expect(yield* Effect.flip(list)).toMatchObject(denied);
          expect(yield* Effect.flip(systemList)).toMatchObject(denied);
          expect(calls).toEqual([]);
        }
      }),
    ),
);
