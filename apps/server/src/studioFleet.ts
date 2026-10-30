import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off - O_NOFOLLOW is required; Effect FileSystem does not expose numeric open flags.
import { constants } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - stat and read must use the same atomically no-follow-opened descriptor.
import { lstat, open } from "node:fs/promises";
import { parseFleetOrigin } from "./fleet/fleetOrigin.ts";
import { tokenProofThumbprint } from "./fleet/fleetProofKey.ts";
import {
  type FleetLink,
  type FleetReached,
  fleetAddresses,
  fleetRequest,
  reachFleetMachine,
  toFleetLink,
} from "./fleet/fleetTransport.ts";
import { join } from "./nodePath.ts";
import {
  AuthAccessWriteScope,
  AuthGrantScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type AuthGrantScopes,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
} from "@specweave-studio/contracts";
import type {
  StudioFleetConnectResult,
  StudioFleetSnapshot,
} from "@specweave-studio/contracts/studioFleet";

export interface FleetTarget {
  readonly id: string;
  readonly label: string;
  readonly environmentId: EnvironmentId;
  /** Primary address: a tailnet origin, or a Connect origin when the machine has no tailnet. */
  readonly url: string;
  /** Optional SpecWithCode Connect origin, only beside a tailnet `url`. */
  readonly connectUrl?: string;
  readonly managementToken?: string;
  readonly scopes: AuthGrantScopes;
}
export interface FleetConfig {
  readonly version: 1;
  /** Explicit operator delegation for preapproved machines, never auth administration. */
  readonly allowConnectFrom?: typeof AuthOrchestrationOperateScope;
  readonly machines: ReadonlyArray<FleetTarget>;
  /** Machine lines skipped by a tolerant read; absent when every line parsed. */
  readonly invalidEntries?: ReadonlyArray<FleetConfigInvalidEntry>;
}
export const fleetConnectPermission = (config: FleetConfig | null) =>
  config?.allowConnectFrom ?? AuthAccessWriteScope;
export class FleetError extends Error {
  readonly kind:
    | "config"
    | "unknown-machine"
    | "unreachable"
    | "identity-mismatch"
    | "pairing-unavailable"
    | "invitation-limited"
    | "reapproval-required"
    | "forbidden"
    | "connect-unbound"
    | "connect-key-missing"
    | "connect-browser-unsupported";
  constructor(kind: FleetError["kind"]) {
    super(
      {
        config: "Private machine configuration could not be read securely.",
        "unknown-machine": "This machine is not configured.",
        unreachable: "This machine is unavailable. Check its private connection and retry.",
        "identity-mismatch":
          "This address belongs to a different machine. Ask the server owner to check its configuration.",
        "pairing-unavailable":
          "Pairing is unavailable. Ask the server owner to renew this machine's connection permission.",
        "invitation-limited":
          "This machine's invitation can manage access but cannot open sessions there, so this machine cannot connect to it. On that machine, update SpecWithCode, choose Invite this machine in Settings > Connections (or run `specwithcode fleet invite --coordinator '<main-machine-environment-id>'`), and add the new line here. Replace <main-machine-environment-id> with the environment ID from Settings > Connections on your main machine. This explicitly approves that machine to manage access here.",
        "reapproval-required":
          "That machine no longer accepts the invitation saved here: its update asks every machine that manages it to be approved again. On that machine, choose Invite this machine in Settings > Connections (or run `specwithcode fleet invite --coordinator '<main-machine-environment-id>'`), and add the new line here. Replace <main-machine-environment-id> with the environment ID from Settings > Connections on your main machine.",
        forbidden: "This connection cannot pair with that machine.",
        "connect-unbound":
          "This machine answers only through SpecWithCode Connect, and the invitation saved here works only over Tailscale. On that machine choose Invite this machine again and add the new line here.",
        "connect-key-missing":
          "This machine's fleet key is missing or unreadable, so the invitation saved for that machine cannot be used. On that machine choose Invite this machine again and add the new line here.",
        "connect-browser-unsupported":
          "That machine answers only through SpecWithCode Connect right now, and opening it in this window needs Tailscale. Work you send to it still goes through.",
      }[kind],
    );
    this.kind = kind;
  }
}
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((key) => allowed.includes(key));
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" &&
  v.trim() === v &&
  v.length > 0 &&
  v.length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(v);

/** A machine line the server skipped; the reason never quotes the line's values. */
export interface FleetConfigInvalidEntry {
  readonly index: number;
  readonly label?: string;
  readonly reason: string;
}
class FleetEntryError extends Error {}

/** One machine line; throws FleetEntryError with an operator-facing reason. */
function parseFleetTarget(m: unknown, allowConnectFrom: unknown): FleetTarget {
  const invalid = (reason: string): never => {
    throw new FleetEntryError(reason);
  };
  if (!record(m)) return invalid("the entry is not an object.");
  if (!keys(m, ["id", "label", "environmentId", "url", "connectUrl", "managementToken", "scopes"]))
    return invalid("the entry has an unknown key.");
  if (!text(m.id, 48) || !/^[a-z0-9][a-z0-9-]*$/.test(m.id))
    return invalid("id must be lowercase letters, digits and dashes.");
  if (!text(m.label, 80)) return invalid("label is missing or malformed.");
  if (!text(m.environmentId, 150)) return invalid("environmentId is missing or malformed.");
  if (!text(m.url, 300)) return invalid("url is missing or malformed.");
  // Even operator-configured machines are reached only over a private Tailscale
  // HTTPS name or a SpecWithCode Connect managed endpoint.
  const primary = parseFleetOrigin(m.url);
  if (primary === null)
    return invalid(
      "url must be a private https://<name>.ts.net address or a SpecWithCode Connect address, with no path, query or credentials.",
    );
  let connectUrl: string | undefined;
  if (m.connectUrl !== undefined) {
    const connect = text(m.connectUrl, 300) ? parseFleetOrigin(m.connectUrl) : null;
    if (connect === null || connect.transport !== "connect")
      return invalid("connectUrl must be a SpecWithCode Connect address with no path or query.");
    if (primary.transport !== "tailnet")
      return invalid("connectUrl is allowed only when url is a Tailscale address.");
    connectUrl = connect.origin;
  }
  if (
    m.managementToken !== undefined &&
    (!text(m.managementToken, 8192) || /\s/.test(m.managementToken))
  )
    return invalid("managementToken is malformed.");
  const scopes = m.scopes ?? [...AuthStandardClientScopes];
  if (
    !Array.isArray(scopes) ||
    !scopes.length ||
    scopes.some((s) => !AuthGrantScope.literals.includes(s)) ||
    new Set(scopes).size !== scopes.length ||
    !scopes.includes(AuthOrchestrationReadScope)
  )
    return invalid("scopes must be distinct known scopes including orchestration:read.");
  if (
    allowConnectFrom !== undefined &&
    scopes.some((scope) => !(AuthStandardClientScopes as ReadonlyArray<string>).includes(scope))
  )
    return invalid("scopes exceed what allowConnectFrom permits.");
  return {
    id: m.id,
    label: m.label,
    environmentId: EnvironmentId.make(m.environmentId),
    url: primary.origin,
    ...(connectUrl === undefined ? {} : { connectUrl }),
    scopes,
    ...(m.managementToken === undefined ? {} : { managementToken: m.managementToken }),
  };
}

/**
 * Local operator configuration only. Request payloads cannot choose a URL, token or scope.
 * Strict by default (every write validates this way). `tolerant` is for reading:
 * a malformed machine line is skipped and listed in `invalidEntries`, so one bad
 * line does not hide every other machine. A malformed document, or two lines
 * sharing an id, environment or address, still rejects the whole file.
 */
export function parseFleetConfig(raw: unknown, options: { tolerant?: boolean } = {}): FleetConfig {
  const invalid = () => {
    throw new FleetError("config");
  };
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !keys(raw, ["version", "machines", "allowConnectFrom"]) ||
    !Array.isArray(raw.machines) ||
    raw.machines.length > 16
  )
    return invalid();
  if (raw.allowConnectFrom !== undefined && raw.allowConnectFrom !== AuthOrchestrationOperateScope)
    return invalid();
  const ids = new Set<string>();
  const envs = new Set<string>();
  const urls = new Set<string>();
  const machines: FleetTarget[] = [];
  const invalidEntries: FleetConfigInvalidEntry[] = [];
  raw.machines.forEach((m: unknown, index) => {
    let target: FleetTarget;
    try {
      target = parseFleetTarget(m, raw.allowConnectFrom);
    } catch (error) {
      if (!options.tolerant || !(error instanceof FleetEntryError)) return invalid();
      const label = record(m) && text(m.label, 80) ? m.label : undefined;
      invalidEntries.push({
        index,
        ...(label === undefined ? {} : { label }),
        reason: error.message,
      });
      return;
    }
    const origins =
      target.connectUrl === undefined ? [target.url] : [target.url, target.connectUrl];
    if (
      ids.has(target.id) ||
      envs.has(target.environmentId) ||
      origins.some((origin) => urls.has(origin))
    )
      return invalid();
    ids.add(target.id);
    envs.add(target.environmentId);
    for (const origin of origins) urls.add(origin);
    machines.push(target);
  });
  return {
    version: 1,
    machines,
    ...(invalidEntries.length ? { invalidEntries } : {}),
    ...(raw.allowConnectFrom === AuthOrchestrationOperateScope
      ? { allowConnectFrom: AuthOrchestrationOperateScope }
      : {}),
  };
}

export const FLEET_CONFIG_FILE = "studio-fleet.json";

/**
 * The file as written, parsed but not normalized, or null when there is none.
 * Never follows a symlink or reads group/world-readable management credentials.
 */
export async function readFleetConfigSource(baseDir: string): Promise<unknown> {
  const path = join(baseDir, FLEET_CONFIG_FILE);
  // Windows has no O_NOFOLLOW and no POSIX mode bits: refuse a link up front,
  // and leave privacy to the profile folder's ACL.
  const windows = process.platform === "win32";
  let file;
  try {
    if (windows && (await lstat(path)).isSymbolicLink()) throw new FleetError("config");
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (!windows && (stat.mode & 0o077) !== 0) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new FleetError("config");
    return JSON.parse(await file.readFile("utf8"));
  } catch (error) {
    if (record(error) && error.code === "ENOENT") return null;
    throw new FleetError("config");
  } finally {
    await file?.close();
  }
}

export async function readFleetConfig(baseDir: string): Promise<FleetConfig | null> {
  const source = await readFleetConfigSource(baseDir);
  return source === null ? null : parseFleetConfig(source, { tolerant: true });
}

export type FleetFetch = typeof globalThis.fetch;

/** Reads a JSON body of at most `maxBytes`, whatever the status. */
export async function readBoundedJson(response: Response, maxBytes = 65536): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes)
    throw new FleetError("unreachable");
  const reader = response.body?.getReader();
  if (!reader) throw new FleetError("unreachable");
  let body = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new FleetError("unreachable");
      body += decoder.decode(part.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return JSON.parse(body + decoder.decode());
}

export async function jsonRequest(
  fetcher: FleetFetch,
  target: Pick<FleetTarget, "url">,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetcher(`${target.url}${path}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new FleetError("unreachable");
  }
  return readBoundedJson(response);
}
export async function checkIdentity(
  fetcher: FleetFetch,
  target: Pick<FleetTarget, "url" | "environmentId">,
) {
  let descriptor: unknown;
  try {
    descriptor = await jsonRequest(fetcher, target, "/.well-known/studio/environment");
  } catch {
    throw new FleetError("unreachable");
  }
  const decoded = Schema.decodeUnknownOption(ExecutionEnvironmentDescriptor)(descriptor);
  if (decoded._tag === "None") throw new FleetError("unreachable");
  if (decoded.value.environmentId !== target.environmentId)
    throw new FleetError("identity-mismatch");
  return decoded.value;
}
/** A machine as the management calls reach it: its addresses, pinned id and token. */
export type FleetManaged = Pick<FleetTarget, "url" | "connectUrl" | "environmentId"> & {
  readonly managementToken: string;
};

/**
 * The scopes a machine's management token holds there, read from its own
 * session endpoint. Pairing there can only hand out scopes the token holds,
 * so a token without them adds a machine nothing can connect to. Null when
 * the machine does not say (an older server); a rejected token fails.
 */
export async function readManagementScopes(
  link: FleetLink | FleetFetch,
  target: FleetManaged,
): Promise<ReadonlySet<string> | null> {
  let response: Response;
  try {
    ({ response } = await fleetRequest(link, target, "/api/auth/session", {
      token: target.managementToken,
      idempotent: true,
    }));
  } catch (error) {
    if (
      error instanceof FleetError &&
      (error.kind === "connect-unbound" ||
        error.kind === "connect-key-missing" ||
        error.kind === "identity-mismatch")
    )
      throw error;
    throw new FleetError("unreachable");
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new FleetError("pairing-unavailable");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = await readBoundedJson(response).catch(() => null);
  if (record(body) && body.authenticated !== true && body.reapprovalRequired === true)
    throw new FleetError("reapproval-required");
  if (!record(body) || body.authenticated !== true) throw new FleetError("pairing-unavailable");
  // `scopes` is the legacy vocabulary and leaves out most of a grant, so only
  // `permissions` says what the token can hand out.
  const granted = body.permissions;
  if (!Array.isArray(granted) || !granted.every((scope) => typeof scope === "string")) return null;
  return new Set(granted);
}

/** Throws when the token cannot hand out every scope a connection asks for. */
export async function assertManagementTokenCanPair(
  link: FleetLink | FleetFetch,
  target: FleetManaged,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): Promise<void> {
  const granted = await readManagementScopes(link, target);
  if (granted !== null && !scopes.every((scope) => granted.has(scope)))
    throw new FleetError("invitation-limited");
}

/** Whether a saved management token is a plain bearer or bound to this machine's fleet key. */
export const managementBindingOf = (token: string): "bearer" | "proof" =>
  tokenProofThumbprint(token) === undefined ? "bearer" : "proof";

export async function discoverFleet(
  config: FleetConfig | null,
  host: string | undefined,
  fetcher: FleetLink | FleetFetch = fetch,
): Promise<StudioFleetSnapshot> {
  const link = toFleetLink(fetcher);
  return {
    configured: config !== null,
    connectPermission: fleetConnectPermission(config),
    observedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    listener:
      !host || ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) ? "loopback" : "network",
    machines: await Promise.all(
      (config?.machines ?? []).map(async (target) => {
        let status: "reachable" | "unreachable" | "identity-mismatch" = "reachable";
        // The name the machine gives itself; a relayed address does not show it.
        let machineName: string | undefined;
        let transport: "tailnet" | "connect" | undefined;
        try {
          const address = await reachFleetMachine(link, target);
          transport = address.transport;
          machineName = address.machineName;
        } catch (error) {
          status =
            error instanceof FleetError && error.kind === "identity-mismatch"
              ? "identity-mismatch"
              : "unreachable";
        }
        return {
          id: target.id,
          label: target.label,
          environmentId: target.environmentId,
          url: target.url,
          ...(target.connectUrl === undefined ? {} : { connectUrl: target.connectUrl }),
          ...(transport === undefined ? {} : { transport }),
          ...(target.managementToken
            ? { managementBinding: managementBindingOf(target.managementToken) }
            : {}),
          status,
          pairingConfigured: Boolean(target.managementToken),
          ...(machineName === undefined ? {} : { machineName }),
        };
      }),
    ),
    ...(config?.invalidEntries?.length
      ? {
          invalidEntries: config.invalidEntries.map((entry) => ({
            kind: "config" as const,
            ...entry,
          })),
        }
      : {}),
  };
}
export async function connectFleet(
  config: FleetConfig | null,
  id: string,
  callerScopes: ReadonlySet<AuthEnvironmentScope>,
  fetcher: FleetLink | FleetFetch = fetch,
): Promise<StudioFleetConnectResult> {
  const link = toFleetLink(fetcher);
  if (
    !callerScopes.has(fleetConnectPermission(config)) ||
    !callerScopes.has(AuthOrchestrationReadScope)
  )
    throw new FleetError("forbidden");
  const target = config?.machines.find((m) => m.id === id);
  if (!target) throw new FleetError("unknown-machine");
  const scopes = target.scopes.filter((scope) => callerScopes.has(scope));
  if (!scopes.includes(AuthOrchestrationReadScope)) throw new FleetError("forbidden");
  if (!target.managementToken) throw new FleetError("pairing-unavailable");
  const managed = { ...target, managementToken: target.managementToken };
  // The browser turns this code into a plain bearer or cookie, which must
  // never live on the internet-facing Connect address (the worker refuses
  // it there too). So pairing uses only the tailnet address, even when
  // Connect answers first for work sent to the machine.
  const tailnet = fleetAddresses(target).find((entry) => entry.transport === "tailnet");
  // Without a tailnet answer, say so only when the machine still answers over Connect.
  const connectOnly = async (): Promise<never> => {
    await reachFleetMachine(link, target, {
      token: managed.managementToken,
      ...(tailnet === undefined ? {} : { exclude: new Set([tailnet.origin]) }),
    });
    throw new FleetError("connect-browser-unsupported");
  };
  if (tailnet === undefined) return connectOnly();
  const pairingTarget = { environmentId: target.environmentId, url: tailnet.origin };
  // Never forwards the token before an address answers as this machine. Reaching
  // the tailnet here makes it the remembered address for a few minutes, so
  // worker calls use it too until the address book entry goes stale.
  let address: FleetReached;
  try {
    address = await reachFleetMachine(link, pairingTarget, { token: managed.managementToken });
  } catch (error) {
    if (error instanceof FleetError && error.kind === "unreachable") return connectOnly();
    throw error;
  }
  let result: unknown;
  let host = address.origin;
  try {
    const { response, address: used } = await fleetRequest(
      link,
      pairingTarget,
      "/api/auth/pairing-token",
      {
        method: "POST",
        token: target.managementToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Private fleet browser", scopes }),
      },
    );
    if (!response.ok || used.transport !== "tailnet") {
      await response.body?.cancel().catch(() => undefined);
      throw new FleetError("unreachable");
    }
    host = used.origin;
    result = await readBoundedJson(response);
  } catch {
    // Name the cause when the token itself is too narrow: re-adding the
    // same line will never work, a new invitation will.
    await assertManagementTokenCanPair(link, managed, scopes);
    throw new FleetError("pairing-unavailable");
  }
  if (
    !record(result) ||
    !text(result.credential, 8192) ||
    !text(result.expiresAt, 64) ||
    !Number.isFinite(Date.parse(result.expiresAt)) ||
    Date.parse(result.expiresAt) <= DateTime.toEpochMillis(DateTime.nowUnsafe())
  )
    throw new FleetError("pairing-unavailable");
  return {
    environmentId: target.environmentId,
    host,
    pairingCode: result.credential,
    expiresAt: result.expiresAt,
    scopes,
  };
}
