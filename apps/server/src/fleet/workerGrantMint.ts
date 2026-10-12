import * as NodeCrypto from "node:crypto";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
} from "@specweave-studio/contracts";
import type { StudioFleetWorkerAccess } from "@specweave-studio/contracts/studioFleet";

import {
  checkIdentity,
  type FleetFetch,
  FleetError,
  type FleetTarget,
  readBoundedJson,
} from "../studioFleet.ts";

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
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown, max = 8192): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

async function request(
  fetcher: FleetFetch,
  url: string,
  init: RequestInit & { readonly form?: Record<string, string>; readonly json?: unknown } = {},
): Promise<Answer> {
  const { form, json, ...rest } = init;
  let response: Response;
  try {
    response = await fetcher(url, {
      ...rest,
      ...(json === undefined
        ? {}
        : {
            body: JSON.stringify(json),
            headers: { ...rest.headers, "content-type": "application/json" },
          }),
      ...(form === undefined
        ? {}
        : {
            body: new URLSearchParams(form).toString(),
            headers: { ...rest.headers, "content-type": "application/x-www-form-urlencoded" },
          }),
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

/** Steps 1 and 2: the pinned identity, then the MCP resource it publishes. */
async function verifyMachine(fetcher: FleetFetch, target: FleetTarget) {
  try {
    await checkIdentity(fetcher, target);
  } catch (error) {
    throw new WorkerGrantMintError(
      error instanceof FleetError && error.kind === "identity-mismatch"
        ? "identity_mismatch"
        : "unreachable",
    );
  }
  const resource = `${target.url}/mcp`;
  const metadata = await request(fetcher, `${target.url}/.well-known/oauth-protected-resource/mcp`);
  if (metadata.status === 404) throw new WorkerGrantMintError("unsupported");
  if (metadata.status !== 200 || !isRecord(metadata.body))
    throw new WorkerGrantMintError("unreachable");
  if (metadata.body.resource !== resource) throw new WorkerGrantMintError("route_mismatch");
  return resource;
}

/** Step 3: a single-use pairing code, minted with the machine's management token. */
async function mintPairingCode(
  fetcher: FleetFetch,
  target: FleetTarget,
  label: string,
): Promise<{ readonly id: string; readonly code: string }> {
  if (
    !target.managementToken ||
    !WORKER_GRANT_SCOPES.every((scope) => target.scopes.includes(scope))
  )
    throw new WorkerGrantMintError("pairing_unavailable");
  const answer = await request(fetcher, `${target.url}/api/auth/pairing-token`, {
    method: "POST",
    headers: { authorization: `Bearer ${target.managementToken}` },
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
async function revokePairing(fetcher: FleetFetch, target: FleetTarget, id: string) {
  if (!target.managementToken) return;
  await request(fetcher, `${target.url}/api/auth/pairing-links/revoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${target.managementToken}` },
    json: { id },
  }).catch(() => undefined);
}

/** Steps 4 to 6: register, approve with the pairing code, exchange the code. */
async function signIn(input: {
  readonly fetcher: FleetFetch;
  readonly target: FleetTarget;
  readonly resource: string;
  readonly clientName: string;
  readonly access: StudioFleetWorkerAccess;
  readonly pairingCode: string;
  readonly now: () => number;
}): Promise<MintedWorkerGrant> {
  const { fetcher, target } = input;
  const registered = await request(fetcher, `${target.url}/oauth/mcp/register`, {
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
  const verifier = base64Url(NodeCrypto.randomBytes(48));
  const challenge = base64Url(NodeCrypto.createHash("sha256").update(verifier).digest());
  const state = base64Url(NodeCrypto.randomBytes(24));
  const decision = await request(fetcher, `${target.url}/oauth/mcp/decision`, {
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
    params.get("iss") !== target.url
  )
    throw new WorkerGrantMintError("route_mismatch");
  const code = params.get("code");
  if (params.get("error") !== null || code === null || code.length === 0)
    throw new WorkerGrantMintError("pairing_code_rejected");
  const token = await request(fetcher, `${target.url}/oauth/mcp/token`, {
    method: "POST",
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
    token.body.token_type !== "Bearer" ||
    typeof token.body.expires_in !== "number" ||
    !Number.isFinite(token.body.expires_in) ||
    token.body.expires_in <= 0
  )
    throw new WorkerGrantMintError("pairing_code_rejected");
  return {
    accessToken: token.body.access_token,
    expiresAt: new Date(input.now() + token.body.expires_in * 1000).toISOString(),
    resource: input.resource,
  };
}

/**
 * Mints a worker grant on `target`. With `pairingCode` the user supplied the
 * approval; otherwise the machine's management token mints a single-use code,
 * which is revoked if the sign-in then fails.
 */
export async function mintWorkerGrant(input: {
  readonly fetcher: FleetFetch;
  readonly target: FleetTarget;
  readonly access: StudioFleetWorkerAccess;
  readonly clientName: string;
  readonly pairingCode?: string | undefined;
  readonly now?: () => number;
}): Promise<MintedWorkerGrant> {
  const now = input.now ?? Date.now;
  const resource = await verifyMachine(input.fetcher, input.target);
  const pairing =
    input.pairingCode === undefined
      ? await mintPairingCode(input.fetcher, input.target, input.clientName)
      : { id: undefined, code: input.pairingCode };
  try {
    return await signIn({
      fetcher: input.fetcher,
      target: input.target,
      resource,
      clientName: input.clientName,
      access: input.access,
      pairingCode: pairing.code,
      now,
    });
  } catch (error) {
    if (pairing.id !== undefined) await revokePairing(input.fetcher, input.target, pairing.id);
    throw error;
  }
}

/** The label a worker grant is minted under on the other machine, as its client list shows it. */
export const workerClientName = (localEnvironmentId: string) =>
  `SpecWithCode workers · ${localEnvironmentId}`.slice(0, 100);

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
export async function revokeWorkerSessions(input: {
  readonly fetcher: FleetFetch;
  readonly target: FleetTarget;
  readonly clientName: string;
  readonly keepNewest: boolean;
  readonly sessionIds?: ReadonlyArray<string>;
  readonly keepSessionId?: string | undefined;
}): Promise<{ readonly revoked: number; readonly complete: boolean; readonly swept: boolean }> {
  const { fetcher, target } = input;
  if (!target.managementToken) return { revoked: 0, complete: false, swept: false };
  const headers = { authorization: `Bearer ${target.managementToken}` };
  const done = new Set<string>();
  let failed = false;
  const revoke = async (sessionId: string) => {
    if (done.has(sessionId) || sessionId === input.keepSessionId) return;
    const answer = await request(fetcher, `${target.url}/api/auth/clients/revoke`, {
      method: "POST",
      headers,
      json: { sessionId },
    });
    if (answer.status === 200) done.add(sessionId);
    else failed = true;
  };
  // Never throws: a machine that drops off mid-revoke is reported as an incomplete revoke.
  try {
    for (const sessionId of input.sessionIds ?? []) await revoke(sessionId);
    const listed = await request(fetcher, `${target.url}/api/auth/clients`, { headers });
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
