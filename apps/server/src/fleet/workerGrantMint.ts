import { randomBytes, sha256 } from "../nodeCrypto.ts";
import * as DateTime from "effect/DateTime";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@specweave-studio/contracts";
import type { StudioFleetWorkerAccess } from "@specweave-studio/contracts/studioFleet";

import { type FleetFetch, FleetError, type FleetTarget, readBoundedJson } from "../studioFleet.ts";
import type { FleetProofKey } from "./fleetProofKey.ts";
import { tokenProofThumbprint } from "./fleetProofKey.ts";
import {
  type FleetLink,
  type FleetOrigin,
  fleetAuthorization,
  reachFleetMachine,
  toFleetLink,
} from "./fleetTransport.ts";
import { WORKER_CLIENT_LABEL_PREFIX } from "./workGrantPolicy.ts";

/**
 * How this server obtains a worker grant on another of the user's machines:
 * an MCP OAuth client session minted on that machine's own `/mcp`, holding
 * `orchestration:read` and `orchestration:operate` and capped at the runtime
 * mode the user chose. These are the same endpoints an outside agent signs in
 * through, driven without a browser: a pairing code (minted with the
 * machine's management token, or pasted by the user) approves the request.
 *
 * Nothing here follows a redirect. The approval answer names where the code
 * would go; it is parsed, never fetched.
 *
 * Every step runs against one address of the machine, the first that answers
 * as it (Connect first, then the tailnet), and the grant is bound to
 * that address's `/mcp`. When the machine supports DPoP and this machine holds
 * a fleet proof key, the grant is bound to that key, so it works over either
 * address. Over Connect a key-bound grant is required: a bearer grant is never
 * minted, renewed or sent there.
 */

/** Registered for the record only; the code is read from the answer, never delivered. */
export const WORKER_GRANT_REDIRECT_URI = "http://127.0.0.1/specwithcode-workers";
const WORKER_GRANT_SCOPES = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope];
const REQUEST_TIMEOUT_MS = 10_000;

export type WorkerGrantFailureReason =
  | "unreachable"
  | "identity_mismatch"
  | "unsupported"
  | "route_mismatch"
  | "pairing_unavailable"
  | "pairing_code_rejected";

export class WorkerGrantMintError extends Error {
  readonly reason: WorkerGrantFailureReason;
  constructor(reason: WorkerGrantFailureReason) {
    super(
      {
        unreachable: "The machine is unavailable. Check its private connection and retry.",
        identity_mismatch: "This address belongs to a different machine.",
        unsupported: "That machine's SpecWithCode is too old to run workers for this one.",
        route_mismatch: "That machine answers for a different address. Check its private route.",
        pairing_unavailable:
          "This server cannot pair with that machine on its own. Enter a pairing code from it.",
        pairing_code_rejected: "That machine did not accept the pairing code.",
      }[reason],
    );
    this.reason = reason;
  }
}

export interface MintedWorkerGrant {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly resource: string;
  /** The address the grant was minted or renewed on. */
  readonly origin: string;
}

/** How calls reach the machine: a fleet link, or a bare fetch (`fetcher`, the older name). */
export type WorkerGrantLink =
  | { readonly link: FleetLink | FleetFetch; readonly fetcher?: undefined }
  | { readonly fetcher: FleetLink | FleetFetch; readonly link?: undefined };

const linkFrom = (input: WorkerGrantLink): FleetLink =>
  toFleetLink((input.link ?? input.fetcher) as FleetLink | FleetFetch);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 8192): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * One call to `path` on `address`. With `token` the authorization header is
 * the one that address allows (bearer on the tailnet, DPoP for a bound token);
 * a token that may not go there is never sent.
 */
async function request(
  link: FleetLink,
  address: FleetOrigin,
  path: string,
  init: Omit<RequestInit, "headers"> & {
    readonly headers?: Record<string, string>;
    readonly form?: Record<string, string>;
    readonly json?: unknown;
    readonly token?: string | undefined;
  } = {},
): Promise<Answer> {
  const { form, json, token, headers: extra, ...rest } = init;
  const url = `${address.origin}${path}`;
  let authorization: Record<string, string> = {};
  if (token !== undefined) {
    try {
      authorization = await fleetAuthorization(link, address, rest.method ?? "GET", url, token);
    } catch {
      throw new WorkerGrantMintError("pairing_unavailable");
    }
  }
  const headers: Record<string, string> = {
    ...extra,
    ...authorization,
    ...(json === undefined ? {} : { "content-type": "application/json" }),
    ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
  };
  let response: Response;
  try {
    response = await link.fetch(url, {
      ...rest,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
      ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new WorkerGrantMintError("unreachable");
  }
  let body: unknown = undefined;
  try {
    body = await readBoundedJson(response);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/**
 * Step 1: the first address that answers as the pinned machine. With `token`,
 * only addresses that token may be sent to are tried.
 */
async function reach(
  link: FleetLink,
  target: FleetTarget,
  token: string | undefined,
): Promise<FleetOrigin> {
  try {
    const { origin, transport } = await reachFleetMachine(
      link,
      target,
      token === undefined ? {} : { token },
    );
    return { origin, transport };
  } catch (error) {
    if (error instanceof FleetError && error.kind === "identity-mismatch")
      throw new WorkerGrantMintError("identity_mismatch");
    // Only a Connect address answers and the management token there is not
    // bound to this machine's key: the machine needs a new invitation.
    if (
      error instanceof FleetError &&
      (error.kind === "connect-unbound" || error.kind === "connect-key-missing")
    )
      throw new WorkerGrantMintError("pairing_unavailable");
    throw new WorkerGrantMintError("unreachable");
  }
}

/** Step 2: the MCP resource the address publishes, and whether it takes DPoP grants. */
async function verifyMachine(link: FleetLink, address: FleetOrigin) {
  const resource = `${address.origin}/mcp`;
  const metadata = await request(link, address, "/.well-known/oauth-protected-resource/mcp");
  if (metadata.status === 404) throw new WorkerGrantMintError("unsupported");
  if (metadata.status !== 200 || !isRecord(metadata.body))
    throw new WorkerGrantMintError("unreachable");
  if (metadata.body.resource !== resource) throw new WorkerGrantMintError("route_mismatch");
  const algorithms = metadata.body.dpop_signing_alg_values_supported;
  const dpop = Array.isArray(algorithms) && algorithms.includes("ES256");
  return { resource, dpop };
}

/** Step 3: a single-use pairing code, minted with the machine's management token. */
async function mintPairingCode(
  link: FleetLink,
  address: FleetOrigin,
  target: FleetTarget,
  label: string,
): Promise<{ readonly id: string; readonly code: string }> {
  if (
    !target.managementToken ||
    !WORKER_GRANT_SCOPES.every((scope) => target.scopes.includes(scope))
  )
    throw new WorkerGrantMintError("pairing_unavailable");
  const answer = await request(link, address, "/api/auth/pairing-token", {
    method: "POST",
    token: target.managementToken,
    json: { label, scopes: WORKER_GRANT_SCOPES },
  });
  if (
    answer.status !== 200 ||
    !isRecord(answer.body) ||
    !isText(answer.body.id, 256) ||
    !isText(answer.body.credential)
  )
    throw new WorkerGrantMintError("pairing_unavailable");
  return { id: answer.body.id, code: answer.body.credential };
}

/** Best effort: an unused pairing code should not outlive a failed sign-in. */
async function revokePairing(
  link: FleetLink,
  address: FleetOrigin,
  target: FleetTarget,
  id: string,
) {
  if (!target.managementToken) return;
  await request(link, address, "/api/auth/pairing-links/revoke", {
    method: "POST",
    token: target.managementToken,
    json: { id },
  }).catch(() => undefined);
}

/** Steps 4 to 6: register, approve with the pairing code, exchange the code. */
async function signIn(input: {
  readonly link: FleetLink;
  readonly address: FleetOrigin;
  /** Binds the grant to this key (DPoP) when set. */
  readonly key: FleetProofKey | null;
  readonly resource: string;
  readonly clientName: string;
  readonly access: StudioFleetWorkerAccess;
  readonly pairingCode: string;
  readonly now: () => number;
}): Promise<MintedWorkerGrant> {
  const { link, address, key } = input;
  const registered = await request(link, address, "/oauth/mcp/register", {
    method: "POST",
    json: { client_name: input.clientName, redirect_uris: [WORKER_GRANT_REDIRECT_URI] },
  });
  if (
    (registered.status !== 200 && registered.status !== 201) ||
    !isRecord(registered.body) ||
    !isText(registered.body.client_id)
  )
    throw new WorkerGrantMintError("unsupported");
  const clientId = registered.body.client_id;
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(sha256([verifier]));
  const state = base64Url(randomBytes(24));
  const decision = await request(link, address, "/oauth/mcp/decision", {
    method: "POST",
    json: {
      authorization: {
        response_type: "code",
        client_id: clientId,
        redirect_uri: WORKER_GRANT_REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        resource: input.resource,
      },
      decision: { _tag: "pairing-code", access: input.access, code: input.pairingCode },
    },
  });
  if (decision.status === 400) throw new WorkerGrantMintError("pairing_code_rejected");
  if (decision.status !== 200 || !isRecord(decision.body) || !isText(decision.body.redirectTo))
    throw new WorkerGrantMintError("unreachable");
  let redirect: URL;
  try {
    redirect = new URL(decision.body.redirectTo);
  } catch {
    throw new WorkerGrantMintError("unreachable");
  }
  const params = redirect.searchParams;
  if (
    `${redirect.origin}${redirect.pathname}` !== WORKER_GRANT_REDIRECT_URI ||
    params.get("state") !== state ||
    params.get("iss") !== address.origin
  )
    throw new WorkerGrantMintError("route_mismatch");
  const code = params.get("code");
  if (params.get("error") !== null || code === null || code.length === 0)
    throw new WorkerGrantMintError("pairing_code_rejected");
  const tokenPath = "/oauth/mcp/token";
  const token = await request(link, address, tokenPath, {
    method: "POST",
    ...(key === null
      ? {}
      : {
          headers: {
            dpop: await key.proof({ method: "POST", url: `${address.origin}${tokenPath}` }),
          },
        }),
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: WORKER_GRANT_REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
      resource: input.resource,
    },
  });
  if (
    token.status !== 200 ||
    !isRecord(token.body) ||
    !isText(token.body.access_token) ||
    typeof token.body.expires_in !== "number" ||
    !Number.isFinite(token.body.expires_in) ||
    token.body.expires_in <= 0
  )
    throw new WorkerGrantMintError("pairing_code_rejected");
  // A bound grant must name this machine's key; a bearer must not be bound.
  if (
    key === null
      ? token.body.token_type !== "Bearer"
      : token.body.token_type !== "DPoP" ||
        tokenProofThumbprint(token.body.access_token) !== key.thumbprint
  )
    throw new WorkerGrantMintError(key === null ? "pairing_code_rejected" : "unsupported");
  return {
    accessToken: token.body.access_token,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(input.now() + token.body.expires_in * 1000)),
    resource: input.resource,
    origin: address.origin,
  };
}

/**
 * Mints a worker grant on `target`. With `pairingCode` the user supplied the
 * approval; otherwise the machine's management token mints a single-use code,
 * which is revoked if the sign-in then fails.
 */
export async function mintWorkerGrant(
  input: WorkerGrantLink & {
    readonly target: FleetTarget;
    readonly access: StudioFleetWorkerAccess;
    readonly clientName: string;
    readonly pairingCode?: string | undefined;
    readonly now?: () => number;
  },
): Promise<MintedWorkerGrant> {
  const now = input.now ?? Date.now;
  const link = linkFrom(input);
  const usesManagementToken = input.pairingCode === undefined;
  const address = await reach(
    link,
    input.target,
    usesManagementToken ? input.target.managementToken : undefined,
  );
  const machine = await verifyMachine(link, address);
  // Bind the grant only for a machine that has (or is reached on) a Connect
  // address: a tailnet-only machine keeps a bearer grant, as before, so it
  // never depends on Serve's forwarded Host matching the proof's URL and
  // writes no replay marker per call.
  const wantsBinding = address.transport === "connect" || input.target.connectUrl !== undefined;
  const key = machine.dpop && wantsBinding ? await link.proofKey().catch(() => null) : null;
  // Over Connect only a key-bound grant may be minted; refuse before any code exists.
  if (address.transport === "connect") {
    if (!machine.dpop) throw new WorkerGrantMintError("unsupported");
    if (key === null) throw new WorkerGrantMintError("pairing_unavailable");
  }
  const pairing = usesManagementToken
    ? await mintPairingCode(link, address, input.target, input.clientName)
    : { id: undefined, code: input.pairingCode as string };
  try {
    return await signIn({
      link,
      address,
      key,
      resource: machine.resource,
      clientName: input.clientName,
      access: input.access,
      pairingCode: pairing.code,
      now,
    });
  } catch (error) {
    if (pairing.id !== undefined) await revokePairing(link, address, input.target, pairing.id);
    throw error;
  }
}

export const canRenewWorkerGrant = (target: FleetTarget) =>
  Boolean(target.managementToken) &&
  [AuthAccessWriteScope, ...WORKER_GRANT_SCOPES].every((scope) => target.scopes.includes(scope));

export class WorkerGrantRenewError extends Error {
  readonly reason: WorkerGrantFailureReason | "revoked" | "missing" | "invalid";
  constructor(reason: WorkerGrantFailureReason | "revoked" | "missing" | "invalid") {
    super("The existing worker grant could not be renewed.");
    this.reason = reason;
  }
}

/** Extends the same destination session. Never exchanges a pairing code or mints a replacement. */
export async function renewWorkerGrant(
  input: WorkerGrantLink & {
    readonly target: FleetTarget;
    readonly accessToken: string;
    readonly coordinatorEnvironmentId: string;
    readonly now?: () => number;
  },
): Promise<MintedWorkerGrant> {
  const { target } = input;
  const link = linkFrom(input);
  if (!canRenewWorkerGrant(target)) throw new WorkerGrantRenewError("pairing_unavailable");
  const sessionId = sessionIdOfToken(input.accessToken);
  if (!sessionId) throw new WorkerGrantRenewError("invalid");
  const binding = tokenProofThumbprint(input.accessToken);
  const address = await reach(link, target, target.managementToken);
  // The grant itself travels in the body: an unbound one never crosses Connect.
  if (address.transport === "connect" && binding === undefined)
    throw new WorkerGrantRenewError("unreachable");
  const { resource } = await verifyMachine(link, address);
  const answer = await request(link, address, "/api/auth/worker-grants/renew", {
    method: "POST",
    token: target.managementToken,
    json: {
      accessToken: input.accessToken,
      coordinatorEnvironmentId: input.coordinatorEnvironmentId,
      environmentId: target.environmentId,
    },
  });
  const code = isRecord(answer.body) ? answer.body.code : undefined;
  if (answer.status === 409 && code === "grant_revoked") throw new WorkerGrantRenewError("revoked");
  if (answer.status === 409 && code === "grant_missing") throw new WorkerGrantRenewError("missing");
  if (answer.status === 400 && code === "grant_invalid") throw new WorkerGrantRenewError("invalid");
  if (answer.status === 404) throw new WorkerGrantRenewError("unsupported");
  if (answer.status === 401 || answer.status === 403)
    throw new WorkerGrantRenewError("pairing_unavailable");
  if (
    answer.status !== 200 ||
    !isRecord(answer.body) ||
    !isText(answer.body.accessToken) ||
    !isText(answer.body.expiresAt, 64) ||
    !Number.isFinite(Date.parse(answer.body.expiresAt)) ||
    Date.parse(answer.body.expiresAt) <= (input.now ?? Date.now)() ||
    sessionIdOfToken(answer.body.accessToken) !== sessionId ||
    tokenProofThumbprint(answer.body.accessToken) !== binding
  )
    throw new WorkerGrantRenewError("unreachable");
  return {
    accessToken: answer.body.accessToken,
    expiresAt: answer.body.expiresAt,
    resource,
    origin: address.origin,
  };
}

/** The label a worker grant is minted under on the other machine, as its client list shows it. */
export const workerClientName = (localEnvironmentId: string) =>
  `${WORKER_CLIENT_LABEL_PREFIX}${localEnvironmentId}`.slice(0, 100);

/** A Studio access token is `<base64url claims>.<signature>`; its claims name the session. */
export function sessionIdOfToken(token: string): string | undefined {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isRecord(claims) && isText(claims.sid, 512) ? claims.sid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Revokes MCP client sessions this server holds on `target`. `sessionIds` are
 * grants this server knows it held, revoked by id with the management token's
 * `access:write`. Strays from earlier grants are found by the label they were
 * minted under, which needs `access:read`; a token without it skips that sweep
 * (`swept` false). `keepSessionId`, or the most recently issued session when
 * `keepNewest` and no id is known, is the grant just minted and is spared.
 * `complete` is true only when every revoke this attempted went through.
 */
export async function revokeWorkerSessions(
  input: WorkerGrantLink & {
    readonly target: FleetTarget;
    readonly clientName: string;
    readonly keepNewest: boolean;
    readonly sessionIds?: ReadonlyArray<string>;
    readonly keepSessionId?: string | undefined;
  },
): Promise<{ readonly revoked: number; readonly complete: boolean; readonly swept: boolean }> {
  const { target } = input;
  const token = target.managementToken;
  if (!token) return { revoked: 0, complete: false, swept: false };
  const link = linkFrom(input);
  const done = new Set<string>();
  let failed = false;
  let address: FleetOrigin;
  try {
    address = await reach(link, target, token);
  } catch {
    return { revoked: 0, complete: false, swept: false };
  }
  const revoke = async (sessionId: string) => {
    if (done.has(sessionId) || sessionId === input.keepSessionId) return;
    const answer = await request(link, address, "/api/auth/clients/revoke", {
      method: "POST",
      token,
      json: { sessionId },
    });
    if (answer.status === 200) done.add(sessionId);
    else failed = true;
  };
  // Never throws: a machine that drops off mid-revoke is reported as an incomplete revoke.
  try {
    for (const sessionId of input.sessionIds ?? []) await revoke(sessionId);
    const listed = await request(link, address, "/api/auth/clients", { token });
    if (listed.status === 403) return { revoked: done.size, complete: !failed, swept: false };
    if (listed.status !== 200 || !Array.isArray(listed.body))
      return { revoked: done.size, complete: false, swept: false };
    const ours = listed.body
      .filter(
        (session): session is Record<string, unknown> & { sessionId: string; issuedAt: string } =>
          isRecord(session) &&
          session.subject === "mcp-client" &&
          isText(session.sessionId, 512) &&
          isText(session.issuedAt, 64) &&
          isRecord(session.client) &&
          session.client.label === input.clientName,
      )
      .toSorted((left, right) => Date.parse(right.issuedAt) - Date.parse(left.issuedAt));
    const doomed = input.keepNewest && input.keepSessionId === undefined ? ours.slice(1) : ours;
    for (const session of doomed) await revoke(session.sessionId);
    return { revoked: done.size, complete: !failed, swept: true };
  } catch {
    return { revoked: done.size, complete: false, swept: false };
  }
}
