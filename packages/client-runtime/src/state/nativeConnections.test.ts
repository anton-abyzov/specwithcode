import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthFilesystemReadScope,
  EnvironmentId,
  ProjectId,
  WS_METHODS,
  type AuthSessionState,
} from "@specweave-studio/contracts";
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
import { createEnvironmentGuardedRpcQueryAtomFamily } from "./runtime.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

it.effect.each([true, false])(
  "checks destination filesystem grants before discovery (allowed=%s)",
  (allowed) =>
    Effect.scoped(
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("native-query-machine");
        const projectId = ProjectId.make("native-query-project");
        const calls: unknown[] = [];
        const snapshot = {
          observedAt: "2026-10-14T00:00:00Z",
          sources: [],
          connections: [],
          truncated: false,
          runtime: "unverified" as const,
        };
        const session = {
          client: {
            [WS_METHODS.nativeConnectionsRead]: (input: unknown) =>
              Effect.sync(() => {
                calls.push(input);
                return snapshot;
              }),
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
          run: (id, effect) => {
            expect(id).toBe(environmentId);
            return Effect.provideService(effect, EnvironmentSupervisor, supervisor);
          },
          followStream: (id, stream) => {
            expect(id).toBe(environmentId);
            return Stream.provideService(stream, EnvironmentSupervisor, supervisor);
          },
        } as EnvironmentRegistry["Service"]);
        const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environments));
        const family = createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
          label: "test-native-query",
          tag: WS_METHODS.nativeConnectionsRead,
        });
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
            scopes: allowed ? [AuthFilesystemReadScope] : [],
            permissions: allowed ? [AuthFilesystemReadScope] : [],
          }),
        );
        const atom = family({ environmentId, input: { projectId } });
        registry.mount(atom);
        const result = AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        if (allowed) {
          expect(yield* result).toEqual(snapshot);
          expect(calls).toEqual([{ projectId }]);
        } else {
          expect(yield* result.pipe(Effect.flip)).toMatchObject({
            _tag: "EnvironmentAuthorizationError",
          });
          expect(calls).toEqual([]);
        }
      }),
    ),
);
