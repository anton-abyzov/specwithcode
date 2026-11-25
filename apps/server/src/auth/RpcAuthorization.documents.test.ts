import {
  type AuthPrincipal,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  DOCUMENT_SESSION_RPC_METHODS,
  RpcScopeAuthorization,
} from "@specweave-studio/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as RpcAuthorization from "./RpcAuthorization.ts";

/**
 * Live document sessions (1480) over the socket, as the server's own check
 * decides them: a connection that may read files watches a sheet and cannot
 * change it, whatever its window sends.
 */
const missing = (scope: string) => RpcAuthorization.rpcAuthorizationError(scope as never).message;

const session = { cwd: "/project", relativePath: "budget.sheet.json", sessionKey: "window-aaaa" };

/** Run one call through the check a connection with `scopes` gets; "ran" when it is let through. */
const attempt = (
  scopes: ReadonlyArray<typeof AuthFilesystemReadScope | typeof AuthFilesystemWriteScope>,
  method: string,
  payload: unknown,
  /** Set for a connection that comes from an approved Connect device rather than this machine. */
  deviceKey?: string,
  principal?: AuthPrincipal,
) =>
  Effect.gen(function* () {
    const authorize = yield* RpcScopeAuthorization;
    return yield* authorize(
      Effect.succeed("ran") as never,
      {
        rpc: { _tag: method },
        payload,
      } as never,
    ).pipe(
      Effect.match({
        onFailure: (error) => (error as { message?: string }).message ?? "refused",
        onSuccess: (value) => String(value),
      }),
    );
  }).pipe(Effect.provide(RpcAuthorization.layer(scopes, principal, deviceKey)));

it.effect("refuses a change to a sheet from a connection that may only read files", () =>
  Effect.gen(function* () {
    const update = DOCUMENT_SESSION_RPC_METHODS.documentSessionUpdate;
    const payload = { ...session, update: "AAA=" };
    expect(yield* attempt([AuthFilesystemReadScope], update, payload)).toBe(
      missing(AuthFilesystemWriteScope),
    );
    // Write alone is not enough either: the change is to a file the connection must be able to read.
    expect(yield* attempt([AuthFilesystemWriteScope], update, payload)).toBe(
      missing(AuthFilesystemReadScope),
    );
    expect(
      yield* attempt([AuthFilesystemReadScope, AuthFilesystemWriteScope], update, payload),
    ).toBe("ran");
  }),
);

it.effect("lets a read-only connection watch a sheet and refuses it an editing session", () =>
  Effect.gen(function* () {
    const open = DOCUMENT_SESSION_RPC_METHODS.documentSessionOpen;
    expect(yield* attempt([AuthFilesystemReadScope], open, { ...session, access: "view" })).toBe(
      "ran",
    );
    expect(yield* attempt([AuthFilesystemReadScope], open, { ...session, access: "edit" })).toBe(
      missing(AuthFilesystemWriteScope),
    );
    expect(yield* attempt([], open, { ...session, access: "view" })).toBe(
      missing(AuthFilesystemReadScope),
    );
    expect(
      yield* attempt(
        [AuthFilesystemReadScope],
        DOCUMENT_SESSION_RPC_METHODS.documentSessionPresence,
        {
          ...session,
          place: null,
        },
      ),
    ).toBe("ran");
  }),
);

it.effect("refuses a live session to a connection from another device, whatever its scopes", () =>
  Effect.gen(function* () {
    const scopes = [AuthFilesystemReadScope, AuthFilesystemWriteScope] as const;
    for (const [method, payload] of [
      [DOCUMENT_SESSION_RPC_METHODS.documentSessionOpen, { ...session, access: "edit" }],
      [DOCUMENT_SESSION_RPC_METHODS.documentSessionOpen, { ...session, access: "view" }],
      [DOCUMENT_SESSION_RPC_METHODS.documentSessionUpdate, { ...session, update: "AAA=" }],
      [DOCUMENT_SESSION_RPC_METHODS.documentSessionPresence, { ...session, place: null }],
    ] as const) {
      expect(yield* attempt(scopes, method, payload, "device-key-1")).toBe(
        RpcAuthorization.REMOTE_DOCUMENT_SESSION_MESSAGE,
      );
      // Another machine acting through its coordinator is refused the same way.
      expect(
        yield* attempt(scopes, method, payload, undefined, {
          kind: "coordinator",
          environmentId: "environment-other" as never,
        }),
      ).toBe(RpcAuthorization.REMOTE_DOCUMENT_SESSION_MESSAGE);
      // A browser paired on this machine is one of its windows.
      expect(
        yield* attempt(scopes, method, payload, undefined, { kind: "device", id: "browser-1" }),
      ).toBe("ran");
      expect(yield* attempt(scopes, method, payload)).toBe("ran");
    }
  }),
);
