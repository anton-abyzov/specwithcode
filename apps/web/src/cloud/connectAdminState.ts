/**
 * The owner-only Connect admin reads. The relay decides who an owner is; this
 * window only asks `/v1/admin/me` once per signed-in Connect session and shows
 * the page when the relay said yes.
 */
import { useAtomValue } from "@effect/atom-react";
import { managedRelaySessionAtom, RelayAdmin } from "@specweave-studio/client-runtime/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback } from "react";

import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

/**
 * Why a read failed. "signed_out": this window has no Connect session.
 * "session_unread": the session is there but its token could not be read, so
 * nothing was asked of Connect.
 */
export interface ConnectAdminFailure {
  readonly kind: RelayAdmin.RelayAdminFailureKind | "signed_out" | "session_unread";
  readonly status: number | null;
  readonly traceId: string | null;
}

export type ConnectAdminRead<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly failure: ConnectAdminFailure };

const SIGNED_OUT: ConnectAdminFailure = { kind: "signed_out", status: null, traceId: null };
const SESSION_UNREAD: ConnectAdminFailure = {
  kind: "session_unread",
  status: null,
  traceId: null,
};
const READ_FAILED: ConnectAdminFailure = { kind: "failed", status: null, traceId: null };

const failureOf = (error: RelayAdmin.RelayAdminRequestError): ConnectAdminFailure => ({
  kind: error.kind,
  status: error.status,
  traceId: error.traceId,
});

const connectAdminAtomRuntime = Atom.runtime(
  Layer.effect(
    RelayAdmin.RelayAdminClient,
    runtime.contextEffect.pipe(
      Effect.map((context) => Context.get(context, RelayAdmin.RelayAdminClient)),
    ),
  ),
);

/**
 * Whether the relay calls this account an owner. Kept for the whole Connect
 * session: the sidebar and the page share one answer and one request.
 */
const ownerAtom = Atom.family((accountId: string) =>
  connectAdminAtomRuntime
    .atom((get) =>
      Effect.gen(function* () {
        const session = get(managedRelaySessionAtom);
        if (session === null || session.accountId !== accountId) return false;
        const clerkToken = yield* session.readClerkToken();
        if (!clerkToken) return false;
        const client = yield* RelayAdmin.RelayAdminClient;
        return yield* client.isOwner({ clerkToken });
      }),
    )
    .pipe(Atom.keepAlive, Atom.withLabel(`connect-admin:owner:${accountId}`)),
);

const SIGNED_OUT_OWNER_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.keepAlive,
  Atom.withLabel("connect-admin:owner:null"),
);

export type ConnectAdminOwnerState = "checking" | "owner" | "not-owner" | "failed";

/** "failed" means the relay could not be asked; it is never read as "owner". */
export function useConnectAdminOwner(): {
  readonly state: ConnectAdminOwnerState;
  readonly retry: () => void;
} {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const result = useAtomValue(accountId ? ownerAtom(accountId) : SIGNED_OUT_OWNER_ATOM);
  const retry = useCallback(() => {
    if (accountId) appAtomRegistry.refresh(ownerAtom(accountId));
  }, [accountId]);
  const state: ConnectAdminOwnerState = AsyncResult.isSuccess(result)
    ? result.value
      ? "owner"
      : "not-owner"
    : AsyncResult.isFailure(result)
      ? "failed"
      : "checking";
  return { state, retry };
}

/** True only once the relay answered that this account is an owner. */
export function useIsConnectAdmin(): boolean {
  return useConnectAdminOwner().state === "owner";
}

/**
 * One admin read with this window's Connect session. It never fails: a failure
 * comes back as a value, so a page cannot mistake it for an empty answer.
 */
export const connectAdminRead = <A>(
  read: (
    client: RelayAdmin.RelayAdminClientShape,
    clerkToken: string,
  ) => Effect.Effect<A, RelayAdmin.RelayAdminRequestError>,
): Effect.Effect<ConnectAdminRead<A>, never, RelayAdmin.RelayAdminClient> =>
  Effect.gen(function* () {
    const session = appAtomRegistry.get(managedRelaySessionAtom);
    if (session === null) return { ok: false, failure: SIGNED_OUT };
    // A token that could not be read is a failure worth retrying, not a sign-out.
    const token = yield* session.readClerkToken().pipe(
      Effect.map((value) => ({ read: true as const, value })),
      Effect.orElseSucceed(() => ({ read: false as const, value: null })),
    );
    if (!token.read) return { ok: false, failure: SESSION_UNREAD };
    const clerkToken = token.value;
    if (!clerkToken) return { ok: false, failure: SIGNED_OUT };
    const client = yield* RelayAdmin.RelayAdminClient;
    return yield* read(client, clerkToken).pipe(
      Effect.match({
        onFailure: (error): ConnectAdminRead<A> => ({ ok: false, failure: failureOf(error) }),
        onSuccess: (value): ConnectAdminRead<A> => ({ ok: true, value }),
      }),
    );
  });

/** `connectAdminRead` for the page: a promise that never rejects. */
export function readConnectAdmin<A>(
  read: (
    client: RelayAdmin.RelayAdminClientShape,
    clerkToken: string,
  ) => Effect.Effect<A, RelayAdmin.RelayAdminRequestError>,
): Promise<ConnectAdminRead<A>> {
  return runtime.runPromise(connectAdminRead(read)).catch((): ConnectAdminRead<A> => {
    // The cause is not logged: it could name the request, and with it an account.
    console.error("[studio-connect] Connect admin read failed");
    return { ok: false, failure: READ_FAILED };
  });
}
