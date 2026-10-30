// @effect-diagnostics-next-line nodeBuiltinImport:off - the fleet file needs exclusive create with mode 0600 and an atomic rename.
import * as NodeFSP from "node:fs/promises";
// @effect-diagnostics-next-line nodeBuiltinImport:off - a random temp name keeps two writers from sharing one file.
import * as NodeCrypto from "node:crypto";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  EnvironmentId,
} from "@specweave-studio/contracts";
import { parseFleetOrigin } from "./fleet/fleetOrigin.ts";
import { loadOrCreateFleetProofKey, tokenProofThumbprint } from "./fleet/fleetProofKey.ts";
import {
  type FleetLink,
  fleetRequest,
  makeFleetLink,
  reachFleetMachine,
  toFleetLink,
} from "./fleet/fleetTransport.ts";
import { join } from "./nodePath.ts";
import {
  assertManagementTokenCanPair,
  FLEET_CONFIG_FILE,
  type FleetFetch,
  FleetError,
  type FleetTarget,
  parseFleetConfig,
  readBoundedJson,
  readFleetConfigSource,
} from "./studioFleet.ts";
import {
  revokeWorkerSessions,
  sessionIdOfToken,
  workerClientName,
} from "./fleet/workerGrantMint.ts";

/**
 * A machine's invitation to join a fleet, made by `fleet invite` on that
 * machine and pasted into `fleet add` (or Settings) on the primary.
 *
 * v1: its private Tailscale HTTPS address, its pinned environment id and a
 * management token that lets the primary mint short-lived pairings there.
 * Tailscale only: a bearer token never travels over a Connect address.
 */
export interface FleetJoinV1 {
  readonly v?: 1;
  readonly url: string;
  readonly environmentId: string;
  readonly label: string;
  readonly managementToken: string;
}

/**
 * v2: the machine's addresses (a tailnet `url` with an optional Connect
 * `connectUrl`, or a Connect `url` alone) and a one-time `redeem` credential
 * the primary exchanges, with a proof of its fleet key, for a management token
 * bound to that key. The line itself carries no bearer.
 */
export interface FleetJoinV2 {
  readonly v: 2;
  readonly url: string;
  readonly connectUrl?: string;
  readonly environmentId: string;
  readonly label: string;
  readonly redeem: string;
}

export type FleetJoin = FleetJoinV1 | FleetJoinV2;

export const isFleetJoinV2 = (join: FleetJoin): join is FleetJoinV2 => join.v === 2;

export const FLEET_JOIN_PREFIX = "swc-machine-";

export class FleetJoinError extends Error {
  readonly kind:
    | "invalid-code"
    | "address-in-use"
    | "id-in-use"
    | "unknown-machine"
    | "write"
    | "invitation-used"
    | "wrong-coordinator"
    | "coordinator-unknown";
  constructor(kind: FleetJoinError["kind"]) {
    super(
      {
        "invalid-code":
          "This is not a machine invitation. Make a new line on that machine (Invite this machine in its Settings > Connections, or `fleet invite --coordinator '<main-machine-environment-id>'`) and copy the whole line. Replace <main-machine-environment-id> with the environment ID from Settings > Connections on your main machine. This explicitly approves that machine to manage access here.",
        "address-in-use": "Another configured machine already uses this address.",
        "id-in-use": "Another configured machine already uses this name.",
        "unknown-machine": "No configured machine has that name.",
        write: "The private machine list could not be saved.",
        "invitation-used":
          "This invitation was already used or has expired. On that machine choose Invite this machine again and add the new line here.",
        "wrong-coordinator":
          "This line was made for a different main machine, so it no longer works. On that machine choose Invite this machine again, paste this machine's environment ID (Settings > Connections) as the main machine environment ID, and add the new line here.",
        "coordinator-unknown":
          "Start SpecWithCode on this machine first: adding this machine needs its environment ID.",
      }[kind],
    );
    this.kind = kind;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function encodeFleetJoinCode(join: FleetJoin): string {
  let body: string;
  if (isFleetJoinV2(join)) {
    body = JSON.stringify({
      v: 2,
      environmentId: join.environmentId,
      label: join.label,
      url: join.url,
      ...(join.connectUrl === undefined ? {} : { connectUrl: join.connectUrl }),
      redeem: join.redeem,
    });
  } else {
    const { v: _v, ...rest } = join;
    body = JSON.stringify({ v: 1, ...rest });
  }
  return FLEET_JOIN_PREFIX + Buffer.from(body, "utf8").toString("base64url");
}

const exactKeys = (value: Record<string, unknown>, allowed: ReadonlyArray<string>) =>
  Object.keys(value).every((key) => allowed.includes(key));

/** The machine line a join names, checked by the fleet file's own rules. */
function checkJoinMachine(machine: Record<string, unknown>): FleetTarget {
  try {
    return parseFleetConfig({ version: 1, machines: [{ id: "invite", ...machine }] }).machines[0]!;
  } catch {
    throw new FleetJoinError("invalid-code");
  }
}

/** Accepts the code with surrounding whitespace or line breaks from a terminal copy. */
export function decodeFleetJoinCode(code: string): FleetJoin {
  const compact = code.replace(/\s+/gu, "");
  if (!compact.startsWith(FLEET_JOIN_PREFIX) || compact.length > 16384)
    throw new FleetJoinError("invalid-code");
  let value: unknown;
  try {
    value = JSON.parse(
      Buffer.from(compact.slice(FLEET_JOIN_PREFIX.length), "base64url").toString("utf8"),
    );
  } catch {
    throw new FleetJoinError("invalid-code");
  }
  if (
    !isRecord(value) ||
    typeof value.url !== "string" ||
    typeof value.environmentId !== "string" ||
    typeof value.label !== "string"
  )
    throw new FleetJoinError("invalid-code");
  if (value.v === 1) {
    if (
      !exactKeys(value, ["v", "url", "environmentId", "label", "managementToken"]) ||
      typeof value.managementToken !== "string"
    )
      throw new FleetJoinError("invalid-code");
    const join = {
      url: value.url,
      environmentId: value.environmentId,
      label: value.label,
      managementToken: value.managementToken,
    };
    // The same rules as the fleet file, and Tailscale only: a v1 line carries a
    // bearer token, which is never sent over a Connect address.
    const parsed = checkJoinMachine(join);
    if (parseFleetOrigin(parsed.url)?.transport !== "tailnet")
      throw new FleetJoinError("invalid-code");
    return { ...join, url: parsed.url };
  }
  if (value.v === 2) {
    if (
      !exactKeys(value, ["v", "url", "connectUrl", "environmentId", "label", "redeem"]) ||
      (value.connectUrl !== undefined && typeof value.connectUrl !== "string") ||
      typeof value.redeem !== "string" ||
      value.redeem.length === 0 ||
      value.redeem.length > 8192 ||
      /\s/u.test(value.redeem)
    )
      throw new FleetJoinError("invalid-code");
    // connectUrl only beside a tailnet url; a lone url may be either.
    const parsed = checkJoinMachine({
      url: value.url,
      ...(value.connectUrl === undefined ? {} : { connectUrl: value.connectUrl }),
      environmentId: value.environmentId,
      label: value.label,
    });
    return {
      v: 2,
      url: parsed.url,
      ...(parsed.connectUrl === undefined ? {} : { connectUrl: parsed.connectUrl }),
      environmentId: value.environmentId,
      label: value.label,
      redeem: value.redeem,
    };
  }
  throw new FleetJoinError("invalid-code");
}

/** A lowercase machine id from its label, unique among `taken`. */
export function fleetMachineIdFor(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || "machine";
  const start = /^[a-z0-9]/u.test(base) ? base : `m-${base}`;
  if (!taken.has(start)) return start;
  for (let n = 2; ; n += 1) {
    const candidate = `${start}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Replaces the fleet file through a new owner-only file and a rename, so a
 * reader never sees half a file and the management tokens are never readable
 * by anyone else, even for a moment. A symlink in its place is refused.
 */
export async function writeFleetConfigSource(baseDir: string, value: unknown): Promise<void> {
  parseFleetConfig(value);
  const target = join(baseDir, FLEET_CONFIG_FILE);
  const existing = await NodeFSP.lstat(target).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw new FleetJoinError("write");
  });
  if (existing !== null && !existing.isFile()) throw new FleetJoinError("write");
  const temp = join(
    baseDir,
    `.${FLEET_CONFIG_FILE}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const file = await NodeFSP.open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFSP.rename(temp, target);
  } catch (error) {
    await NodeFSP.rm(temp, { force: true }).catch(() => undefined);
    throw error instanceof FleetJoinError ? error : new FleetJoinError("write");
  }
}

export interface FleetAddResult {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly environmentId: EnvironmentId;
  /** added: a new machine; updated: a configured machine's address or token changed. */
  readonly change: "added" | "updated";
  /** The machine was configured before at another address. */
  readonly previousUrl?: string;
  /** The machine's SpecWithCode Connect address, when the invitation carried one. */
  readonly connectUrl?: string;
  /**
   * The management session a v2 line was redeemed for on that machine, so a
   * caller that only needed it for setup can revoke it there. Absent for a
   * v1 line, whose invitation already names its session.
   */
  readonly sessionId?: AuthSessionId;
}

/**
 * Adds the machine an invitation names, or updates the one already configured
 * with its environment id (a machine that moved to a new address keeps its id,
 * label, scopes and the workers allowed on it). The address must answer as
 * that environment before anything is written.
 */
export async function addFleetMachine(input: {
  readonly baseDir: string;
  readonly code: string;
  readonly id?: string | undefined;
  readonly label?: string | undefined;
  /** How the machine is reached; a bare fetch works too. */
  readonly link?: FleetLink | FleetFetch;
  /** Older name for `link`. */
  readonly fetcher?: FleetFetch;
  /** This machine's environment id; a v2 invitation is redeemed for it. */
  readonly localEnvironmentId?: string | undefined;
}): Promise<FleetAddResult> {
  const invite = decodeFleetJoinCode(input.code);
  const fetcher = input.link ?? input.fetcher ?? fetch;
  const source = (await readFleetConfigSource(input.baseDir)) ?? { version: 1, machines: [] };
  parseFleetConfig(source);
  const document = source as Record<string, unknown> & {
    machines: Array<Record<string, unknown>>;
  };
  const environmentId = EnvironmentId.make(invite.environmentId);
  const connectUrl = isFleetJoinV2(invite) ? invite.connectUrl : undefined;
  const origins = connectUrl === undefined ? [invite.url] : [invite.url, connectUrl];
  const index = document.machines.findIndex(
    (machine) => machine.environmentId === invite.environmentId,
  );
  const originOf = (value: unknown) => {
    try {
      return typeof value === "string" ? new URL(value).origin : null;
    } catch {
      return null;
    }
  };
  // File checks come before anything is sent: a v2 line is spent by redeeming it.
  const sameUrl = document.machines.findIndex(
    (machine) =>
      origins.includes(originOf(machine.url) ?? "") ||
      origins.includes(originOf(machine.connectUrl) ?? ""),
  );
  if (sameUrl !== -1 && sameUrl !== index) throw new FleetJoinError("address-in-use");
  const taken = new Set(document.machines.map((machine) => String(machine.id)));
  if (index === -1 && input.id !== undefined && taken.has(input.id))
    throw new FleetJoinError("id-in-use");
  if (isFleetJoinV2(invite) && !input.localEnvironmentId)
    throw new FleetJoinError("coordinator-unknown");

  const machine = {
    url: invite.url,
    ...(connectUrl === undefined ? {} : { connectUrl }),
    environmentId,
  };
  // A v2 line redeems with this machine's fleet key, so the link must know it.
  const link =
    isFleetJoinV2(invite) && typeof fetcher === "function"
      ? makeFleetLink({ fetch: fetcher, baseDir: input.baseDir })
      : toFleetLink(fetcher);
  const reached = await reachFleetMachine(link, machine);
  const label = (input.label ?? invite.label).trim() || reached.machineName || invite.label;
  const redeemed = isFleetJoinV2(invite)
    ? await redeemFleetInvitation({
        baseDir: input.baseDir,
        link,
        machine,
        redeem: invite.redeem,
        coordinatorEnvironmentId: input.localEnvironmentId!,
      })
    : { token: invite.managementToken };
  const managementToken = redeemed.token;
  const redeemedSession =
    redeemed.sessionId === undefined ? {} : { sessionId: AuthSessionId.make(redeemed.sessionId) };
  // An invitation whose token cannot open sessions there would be saved as
  // "Added" yet never connect, so check it before writing anything.
  const wantedScopes = (
    index !== -1 && Array.isArray(document.machines[index]!.scopes)
      ? document.machines[index]!.scopes
      : AuthStandardClientScopes
  ) as ReadonlyArray<AuthEnvironmentScope>;
  await assertManagementTokenCanPair(link, { ...machine, managementToken }, wantedScopes);

  let result: FleetAddResult;
  const machines = [...document.machines];
  if (index !== -1) {
    const previous = machines[index]!;
    const previousUrl = new URL(String(previous.url)).origin;
    const { connectUrl: _previousConnect, ...kept } = previous;
    // A Connect-only refresh upgrades the credential without throwing away
    // this same pinned machine's existing private fallback address.
    const keepTailnet =
      connectUrl === undefined &&
      parseFleetOrigin(invite.url)?.transport === "connect" &&
      parseFleetOrigin(previousUrl)?.transport === "tailnet";
    const savedUrl = keepTailnet ? previousUrl : invite.url;
    const savedConnectUrl = keepTailnet ? invite.url : connectUrl;
    const next: Record<string, unknown> = {
      ...kept,
      url: savedUrl,
      ...(savedConnectUrl === undefined ? {} : { connectUrl: savedConnectUrl }),
      managementToken,
      ...(input.label === undefined ? {} : { label }),
    };
    machines[index] = next;
    result = {
      id: String(next.id),
      label: String(next.label),
      url: savedUrl,
      ...(savedConnectUrl === undefined ? {} : { connectUrl: savedConnectUrl }),
      environmentId,
      change: "updated",
      ...(previousUrl === savedUrl ? {} : { previousUrl }),
      ...redeemedSession,
    };
  } else {
    const id = input.id ?? fleetMachineIdFor(label, taken);
    machines.push({
      id,
      label,
      environmentId: invite.environmentId,
      url: invite.url,
      ...(connectUrl === undefined ? {} : { connectUrl }),
      managementToken,
    });
    result = {
      id,
      label,
      url: invite.url,
      ...(connectUrl === undefined ? {} : { connectUrl }),
      environmentId,
      change: "added",
      ...redeemedSession,
    };
  }
  const next = { ...document, machines };
  try {
    parseFleetConfig(next);
  } catch (error) {
    throw error instanceof FleetError ? new FleetJoinError("invalid-code") : error;
  }
  await writeFleetConfigSource(input.baseDir, next);
  return result;
}

/**
 * Spends a v2 line's one-time credential on the machine for a management
 * token bound to this machine's fleet key, proving the key with the request.
 * A token that comes back unbound, or bound to another key, is refused.
 */
async function redeemFleetInvitation(input: {
  readonly baseDir: string;
  readonly link: FleetLink;
  readonly machine: Pick<FleetTarget, "url" | "connectUrl" | "environmentId">;
  readonly redeem: string;
  readonly coordinatorEnvironmentId: string;
}): Promise<{ readonly token: string; readonly sessionId?: string | undefined }> {
  const key = await loadOrCreateFleetProofKey(input.baseDir).catch(() => {
    throw new FleetError("connect-key-missing");
  });
  const address = await reachFleetMachine(input.link, input.machine);
  const url = `${address.origin}/api/studio/fleet/invitation/redeem`;
  let response: Response;
  try {
    response = await input.link.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        dpop: await key.proof({ method: "POST", url }),
      },
      body: JSON.stringify({
        credential: input.redeem,
        coordinatorEnvironmentId: input.coordinatorEnvironmentId,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new FleetError("unreachable");
  }
  if (response.status === 400) {
    // The machine spends the line, then says when it named another main machine.
    const body = await readBoundedJson(response).catch(() => null);
    const message = isRecord(body) && typeof body.message === "string" ? body.message : "";
    throw new FleetJoinError(
      /different main machine/iu.test(message) ? "wrong-coordinator" : "invitation-used",
    );
  }
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    throw new FleetJoinError("invitation-used");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new FleetError("unreachable");
  }
  const body = await readBoundedJson(response).catch(() => null);
  const token = isRecord(body) ? body.managementToken : undefined;
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 8192 ||
    /\s/u.test(token) ||
    tokenProofThumbprint(token) !== key.thumbprint
  )
    throw new FleetError("pairing-unavailable");
  const sessionId = isRecord(body) ? body.sessionId : undefined;
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 256
    ? { token, sessionId }
    : { token };
}

/** Removes a configured machine by id or label. Workers allowed there stay until revoked there. */
export async function removeFleetMachine(input: {
  readonly baseDir: string;
  readonly machine: string;
}): Promise<{ readonly id: string; readonly label: string; readonly environmentId: string }> {
  const source = await readFleetConfigSource(input.baseDir);
  if (source === null) throw new FleetJoinError("unknown-machine");
  parseFleetConfig(source);
  const document = source as Record<string, unknown> & {
    machines: Array<Record<string, unknown>>;
  };
  const wanted = input.machine.trim().toLowerCase();
  const found = document.machines.find(
    (machine) =>
      String(machine.id) === wanted || String(machine.label).trim().toLowerCase() === wanted,
  );
  if (!found) throw new FleetJoinError("unknown-machine");
  await writeFleetConfigSource(input.baseDir, {
    ...document,
    machines: document.machines.filter((machine) => machine !== found),
  });
  return {
    id: String(found.id),
    label: String(found.label),
    environmentId: String(found.environmentId),
  };
}

/** What removing a machine did there: revoked, still valid there, or nothing was held. */
export type FleetRemoteRevoke = "revoked" | "kept" | "none";

export interface FleetRemoveResult {
  readonly id: string;
  readonly label: string;
  readonly environmentId: string;
  readonly managementToken: FleetRemoteRevoke;
  readonly workerAccess: FleetRemoteRevoke;
  /** The management token's session there, for revoking it on that machine when kept. */
  readonly managementSessionId: string | null;
}

const REVOKE_TIMEOUT_MS = 10_000;

/**
 * The management token gives itself up on the machine it was made for.
 * Only after that machine answers as itself: a token is never sent to an
 * address that now belongs to someone else. An older machine without the
 * endpoint keeps it (it lapses at expiry or is revoked there by hand).
 */
export async function revokeManagementToken(
  fetcher: FleetLink | FleetFetch,
  target: Pick<FleetTarget, "url" | "connectUrl" | "environmentId" | "managementToken">,
): Promise<{ readonly result: FleetRemoteRevoke; readonly sessionId: string | null }> {
  if (!target.managementToken) return { result: "none", sessionId: null };
  const sessionId = sessionIdOfToken(target.managementToken) ?? null;
  try {
    const { response } = await fleetRequest(fetcher, target, "/api/auth/session/revoke", {
      method: "POST",
      token: target.managementToken,
      timeoutMs: REVOKE_TIMEOUT_MS,
    });
    // 401: that machine no longer honors the token, which is the outcome wanted.
    if (response.status === 200 || response.status === 401) return { result: "revoked", sessionId };
    return { result: "kept", sessionId };
  } catch {
    return { result: "kept", sessionId };
  }
}

/**
 * Removes a machine and gives up what this machine holds there: worker
 * access (through `revokeWorkerAccess`, which must not throw) and the
 * management token, while the token can still reach it. The machine leaves
 * the list either way; what could not be revoked there is reported.
 */
export async function removeFleetMachineEverywhere(input: {
  readonly baseDir: string;
  readonly machine: string;
  readonly fetcher: FleetLink | FleetFetch;
  readonly revokeWorkerAccess: (target: FleetTarget) => Promise<FleetRemoteRevoke>;
  /** Revokes the phone sessions this machine linked there; must not throw. */
  readonly unlinkPhones?: (target: FleetTarget) => Promise<void>;
}): Promise<FleetRemoveResult> {
  const source = await readFleetConfigSource(input.baseDir);
  if (source === null) throw new FleetJoinError("unknown-machine");
  const config = parseFleetConfig(source);
  const wanted = input.machine.trim().toLowerCase();
  const target = config.machines.find(
    (machine) => machine.id === wanted || machine.label.trim().toLowerCase() === wanted,
  );
  if (!target) throw new FleetJoinError("unknown-machine");
  const workerAccess = await input.revokeWorkerAccess(target);
  // Before the management token goes: it is what reaches the phone links there.
  await input.unlinkPhones?.(target).catch(() => undefined);
  const management = await revokeManagementToken(input.fetcher, target);
  const removed = await removeFleetMachine({ baseDir: input.baseDir, machine: target.id });
  return {
    ...removed,
    managementToken: management.result,
    workerAccess,
    managementSessionId: management.result === "revoked" ? null : management.sessionId,
  };
}

/**
 * Worker access this machine holds on `target`, found by the label its
 * grants are minted under, revoked with the management token. For the CLI,
 * which has no running grant store; the server uses its own.
 */
export async function revokeWorkerAccessByLabel(
  fetcher: FleetLink | FleetFetch,
  target: FleetTarget,
  localEnvironmentId: string | undefined,
): Promise<FleetRemoteRevoke> {
  if (!target.managementToken || localEnvironmentId === undefined) return "kept";
  // The link carries this machine's proof key, so a bound token goes over
  // any address as DPoP and an unbound one only over the tailnet
  // (`fleetAuthorization`); an unreachable machine is reported as kept.
  const swept = await revokeWorkerSessions({
    link: toFleetLink(fetcher),
    target,
    clientName: workerClientName(localEnvironmentId),
    keepNewest: false,
  });
  if (!swept.complete || !swept.swept) return "kept";
  return swept.revoked > 0 ? "revoked" : "none";
}
