import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { createClerkClient } from "@clerk/backend";
import { ClerkAPIResponseError } from "@clerk/backend/errors";
import { vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the expected endpoint key is a synchronous sha256.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { EnvironmentId } from "@specweave-studio/contracts";

import * as RelayConfiguration from "../Config.ts";
import { managedEndpointTunnelName } from "../deploymentConfig.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "../environments/ManagedTunnelLimits.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as RelayHttpApi from "../http/Api.ts";
import { RelayApi, RelayClientAuth, RelayClientPrincipal } from "@specweave-studio/contracts/relay";
import * as AccountDeletion from "./AccountDeletion.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const NAMESPACE = "test";
const USER = "user-1";

const expectedEndpointKey = (environmentId: string) => {
  const hash = NodeCrypto.createHash("sha256")
    .update(`${NAMESPACE}:${USER}:${environmentId}`)
    .digest("hex");
  return HeldHooks.endpointKeyForTunnelName(NAMESPACE, managedEndpointTunnelName(NAMESPACE, hash));
};

/** In-memory relay state for one user, shared across retries. */
function makeFakeRelay(input: {
  readonly activeLinks: ReadonlyArray<string>;
  readonly revokedLinks?: ReadonlyArray<string>;
  readonly allocations: ReadonlyArray<string>;
}) {
  const links = new Map<string, boolean>();
  for (const id of input.activeLinks) links.set(id, true);
  for (const id of input.revokedLinks ?? []) links.set(id, false);
  const allocations = new Set(input.allocations);
  const log: Array<string> = [];
  const faults = {
    deprovision: new Set<string>(),
    keepAllocation: new Set<string>(),
    clerk: 0,
  };

  const layer = Layer.mergeAll(
    Layer.mock(ManagedTunnelLimits.ManagedTunnelLimits, {}),
    Layer.mock(EnvironmentLinks.EnvironmentLinks, {
      getForUser: ({ environmentId }) =>
        Effect.succeed(
          links.get(environmentId)
            ? ({
                environmentId: EnvironmentId.make(environmentId),
                environmentPublicKey: `key-${environmentId}`,
              } as never)
            : null,
        ),
      revokeForUser: ({ environmentId, environmentPublicKey }) =>
        Effect.sync(() => {
          const active = links.get(environmentId) === true;
          if (active) links.set(environmentId, false);
          log.push(`revoke:${environmentId}`);
          if (active && environmentPublicKey === `key-${environmentId}`) {
            log.push(`revoke-credential:${environmentId}`);
          }
          return active;
        }),
    }),
    Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {}),
    Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {
      prepareDeprovision: ({ environmentId }) =>
        Effect.succeed(
          allocations.has(environmentId)
            ? ({ environmentId, tunnelName: "unrelated" } as never)
            : null,
        ),
      deprovision: ({ userId, environmentId }) =>
        Effect.gen(function* () {
          if (faults.deprovision.has(environmentId)) {
            return yield* new ManagedEndpointProvider.ManagedEndpointDeprovisioningFailed({
              stage: "delete-tunnel",
              userId,
              environmentId,
              cause: new Error("cloudflare down"),
            });
          }
          log.push(`deprovision:${environmentId}`);
          if (faults.keepAllocation.has(environmentId)) return false;
          return allocations.delete(environmentId) || true;
        }),
    }),
    Layer.mock(HookInbox.HookInbox, {
      clear: ({ endpointKey }) => Effect.sync(() => void log.push(`clear-inbox:${endpointKey}`)),
    }),
    Layer.succeed(
      AccountDeletion.AccountRecords,
      AccountDeletion.AccountRecords.of({
        listEnvironmentIds: () => Effect.succeed([...new Set([...links.keys(), ...allocations])]),
        listAllocatedEnvironmentIds: () => Effect.succeed([...allocations]),
        markDeleting: ({ userId }) => Effect.sync(() => void log.push(`mark-deleting:${userId}`)),
        deleteUserRows: ({ userId }) =>
          Effect.sync(() => {
            if (allocations.size > 0) return false;
            links.clear();
            log.push(`delete-rows:${userId}`);
            return true;
          }),
      }),
    ),
    Layer.succeed(
      AccountDeletion.ClerkUsers,
      AccountDeletion.ClerkUsers.of({
        deleteUser: (userId) =>
          Effect.gen(function* () {
            if (faults.clerk > 0) {
              faults.clerk -= 1;
              return yield* new AccountDeletion.ClerkUserDeletionFailed({
                userId,
                cause: new Error("clerk down"),
              });
            }
            log.push(`delete-clerk-user:${userId}`);
          }),
      }),
    ),
    NodeCryptoLayer.layer,
  );
  return { layer, log, faults, links, allocations };
}

const deleteAccount = AccountDeletion.deleteAccountRecords({
  userId: USER,
  managedEndpointNamespace: NAMESPACE,
});

describe("account deletion", () => {
  it.effect("unlinks every environment, then deletes rows, then the Clerk user", () => {
    const relay = makeFakeRelay({
      activeLinks: ["env-a"],
      revokedLinks: ["env-b"],
      allocations: ["env-a", "env-c"],
    });
    return Effect.gen(function* () {
      const result = yield* deleteAccount;
      expect(result).toEqual({ deleted: true, environmentCount: 3 });
      expect(relay.log).toEqual([
        `mark-deleting:${USER}`,
        "revoke:env-a",
        "revoke-credential:env-a",
        "deprovision:env-a",
        `clear-inbox:${expectedEndpointKey("env-a")}`,
        "deprovision:env-b",
        `clear-inbox:${expectedEndpointKey("env-b")}`,
        "deprovision:env-c",
        `clear-inbox:${expectedEndpointKey("env-c")}`,
        `delete-rows:${USER}`,
        `delete-clerk-user:${USER}`,
      ]);
      expect(relay.allocations.size).toBe(0);
    }).pipe(Effect.provide(relay.layer));
  });

  it.effect(
    "stops before deleting rows or the Clerk user when a tunnel fails, and a retry finishes",
    () => {
      const relay = makeFakeRelay({ activeLinks: ["env-a"], allocations: ["env-a"] });
      relay.faults.deprovision.add("env-a");
      return Effect.gen(function* () {
        const failed = yield* Effect.exit(deleteAccount);
        expect(Exit.isFailure(failed)).toBe(true);
        expect(relay.log).toEqual([
          `mark-deleting:${USER}`,
          "revoke:env-a",
          "revoke-credential:env-a",
        ]);

        relay.faults.deprovision.clear();
        relay.log.length = 0;
        expect(yield* deleteAccount).toEqual({ deleted: true, environmentCount: 1 });
        expect(relay.log).toEqual([
          `mark-deleting:${USER}`,
          "deprovision:env-a",
          `clear-inbox:${expectedEndpointKey("env-a")}`,
          `delete-rows:${USER}`,
          `delete-clerk-user:${USER}`,
        ]);
      }).pipe(Effect.provide(relay.layer));
    },
  );

  it.effect("refuses to delete the Clerk user while a managed endpoint remains", () => {
    const relay = makeFakeRelay({ activeLinks: [], allocations: ["env-a"] });
    relay.faults.keepAllocation.add("env-a");
    return Effect.gen(function* () {
      const error = yield* Effect.flip(deleteAccount);
      expect(error).toMatchObject({ _tag: "AccountDeletionIncomplete", environmentIds: ["env-a"] });
      expect(relay.log.some((entry) => entry.startsWith("delete-"))).toBe(false);
    }).pipe(Effect.provide(relay.layer));
  });

  it.effect("retries after a Clerk failure without leaving relay records behind", () => {
    const relay = makeFakeRelay({ activeLinks: ["env-a"], allocations: ["env-a"] });
    relay.faults.clerk = 1;
    return Effect.gen(function* () {
      const error = yield* Effect.flip(deleteAccount);
      expect(error).toMatchObject({ _tag: "ClerkUserDeletionFailed" });
      expect(relay.links.size).toBe(0);
      expect(relay.allocations.size).toBe(0);

      relay.log.length = 0;
      expect(yield* deleteAccount).toEqual({ deleted: true, environmentCount: 0 });
      expect(relay.log).toEqual([
        `mark-deleting:${USER}`,
        `delete-rows:${USER}`,
        `delete-clerk-user:${USER}`,
      ]);
    }).pipe(Effect.provide(relay.layer));
  });
});

const relaySettings = {
  relayIssuer: "https://relay.example.test",
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  managedEndpointNamespace: NAMESPACE,
} as unknown as RelayConfiguration.RelayConfiguration["Service"];

describe("Clerk user deletion", () => {
  it.effect("treats a user Clerk no longer has as deleted", () => {
    const deleteUser = vi
      .fn()
      .mockRejectedValueOnce(new ClerkAPIResponseError("Not Found", { data: [], status: 404 }))
      .mockRejectedValueOnce(new ClerkAPIResponseError("Bad", { data: [], status: 500 }));
    vi.mocked(createClerkClient).mockReturnValue({ users: { deleteUser } } as never);
    return Effect.gen(function* () {
      const clerk = yield* AccountDeletion.ClerkUsers;
      yield* clerk.deleteUser(USER);
      const error = yield* Effect.flip(clerk.deleteUser(USER));
      expect(error).toMatchObject({ _tag: "ClerkUserDeletionFailed", userId: USER });
      expect(deleteUser).toHaveBeenCalledWith(USER);
    }).pipe(
      Effect.provide(
        AccountDeletion.layerClerkUsers.pipe(
          Layer.provide(Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings)),
        ),
      ),
    );
  });
});

describe("DELETE /v1/client/account", () => {
  const request = () =>
    new Request("https://relay.example.test/v1/client/account", {
      method: "DELETE",
      headers: { authorization: "Bearer test-token" },
    });

  // Handlers resolve these per request, as the worker's runtime does.
  const send = (relay: ReturnType<typeof makeFakeRelay>) =>
    Effect.gen(function* () {
      const app = yield* withApp(relay);
      const context = yield* Layer.build(relay.layer);
      return yield* Effect.promise(() => app.handler(request(), context));
    });

  const withApp = (relay: ReturnType<typeof makeFakeRelay>) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.client)).pipe(
            Layer.provide(
              RelayHttpApi.layerClientApi.pipe(
                Layer.provide(
                  Layer.mergeAll(
                    Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
                    NodeCryptoLayer.layer,
                    Layer.mock(RelayTokens.RelayTokens, {
                      resolveDpopAccessTokenScopes: () => null,
                    }),
                    Layer.mock(EnvironmentLinker.EnvironmentLinker, {}),
                    Layer.mock(Devices.Devices, {}),
                    relay.layer,
                    Layer.succeed(RelayClientAuth, {
                      clientBearer: (effect) =>
                        Effect.provideService(effect, RelayClientPrincipal, {
                          userId: USER,
                          token: "test-token",
                        }),
                    }),
                  ),
                ),
              ),
            ),
            Layer.provide(HttpServer.layerServices),
          ),
          { disableLogger: true },
        ),
      ),
      (app) => Effect.promise(() => app.dispose()),
    );

  it.effect("deletes the calling account", () => {
    const relay = makeFakeRelay({ activeLinks: ["env-a"], allocations: ["env-a"] });
    return Effect.gen(function* () {
      const response = yield* send(relay);
      expect(response.status).toBe(200);
      expect(yield* Effect.promise(() => response.json())).toEqual({
        deleted: true,
        environmentCount: 1,
      });
      expect(relay.log.at(-1)).toBe(`delete-clerk-user:${USER}`);
    }).pipe(Effect.scoped);
  });

  it.effect("reports a retryable upstream failure while a tunnel cannot be deleted", () => {
    const relay = makeFakeRelay({ activeLinks: ["env-a"], allocations: ["env-a"] });
    relay.faults.deprovision.add("env-a");
    return Effect.gen(function* () {
      const response = yield* send(relay);
      expect(response.status).toBe(500);
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        code: "internal_error",
        reason: "upstream_unavailable",
      });
      expect(relay.log).not.toContain(`delete-clerk-user:${USER}`);
    }).pipe(Effect.scoped);
  });
});
