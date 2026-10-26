import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
// @effect-diagnostics-next-line nodeBuiltinImport:off - O_NOFOLLOW is required; Effect FileSystem does not expose numeric open flags.
import { constants } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off - stat and read must use the same atomically no-follow-opened descriptor.
import { lstat, open } from "node:fs/promises";
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
  readonly url: string;
  readonly managementToken?: string;
  readonly scopes: AuthGrantScopes;
}
export interface FleetConfig {
  readonly version: 1;
  /** Explicit operator delegation for preapproved machines, never auth administration. */
  readonly allowConnectFrom?: typeof AuthOrchestrationOperateScope;
  readonly machines: ReadonlyArray<FleetTarget>;
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
    | "forbidden";
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

/** Local operator configuration only. Request payloads cannot choose a URL, token or scope. */
export function parseFleetConfig(raw: unknown): FleetConfig {
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
  const machines = raw.machines.map((m): FleetTarget => {
    if (
      !record(m) ||
      !keys(m, ["id", "label", "environmentId", "url", "managementToken", "scopes"]) ||
      !text(m.id, 48) ||
      !/^[a-z0-9][a-z0-9-]*$/.test(m.id) ||
      !text(m.label, 80) ||
      !text(m.environmentId, 150) ||
      !text(m.url, 300)
    )
      return invalid();
    let url: URL;
    try {
      url = new URL(m.url);
    } catch {
      return invalid();
    }
    // Restrict even operator-configured relays to private Tailscale HTTPS origins.
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net$/i.test(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return invalid();
    if (ids.has(m.id) || envs.has(m.environmentId) || urls.has(url.origin)) return invalid();
    ids.add(m.id);
    envs.add(m.environmentId);
    urls.add(url.origin);
    if (
      m.managementToken !== undefined &&
      (!text(m.managementToken, 8192) || /\s/.test(m.managementToken))
    )
      return invalid();
    const scopes = m.scopes ?? [...AuthStandardClientScopes];
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.some((s) => !AuthGrantScope.literals.includes(s)) ||
      new Set(scopes).size !== scopes.length ||
      !scopes.includes(AuthOrchestrationReadScope)
    )
      return invalid();
    if (
      raw.allowConnectFrom !== undefined &&
      scopes.some((scope) => !(AuthStandardClientScopes as ReadonlyArray<string>).includes(scope))
    )
      return invalid();
    return {
      id: m.id,
      label: m.label,
      environmentId: EnvironmentId.make(m.environmentId),
      url: url.origin,
      scopes,
      ...(m.managementToken === undefined ? {} : { managementToken: m.managementToken }),
    };
  });
  return {
    version: 1,
    machines,
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
  return source === null ? null : parseFleetConfig(source);
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
/**
 * The scopes a machine's management token holds there, read from its own
 * session endpoint. Pairing there can only hand out scopes the token holds,
 * so a token without them adds a machine nothing can connect to. Null when
 * the machine does not say (an older server); a rejected token fails.
 */
export async function readManagementScopes(
  fetcher: FleetFetch,
  target: Pick<FleetTarget, "url"> & { readonly managementToken: string },
): Promise<ReadonlySet<string> | null> {
  let response: Response;
  try {
    response = await fetcher(`${target.url}/api/auth/session`, {
      headers: { authorization: `Bearer ${target.managementToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
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
  fetcher: FleetFetch,
  target: Pick<FleetTarget, "url"> & { readonly managementToken: string },
  scopes: ReadonlyArray<AuthEnvironmentScope>,
): Promise<void> {
  const granted = await readManagementScopes(fetcher, target);
  if (granted !== null && !scopes.every((scope) => granted.has(scope)))
    throw new FleetError("invitation-limited");
}

export async function discoverFleet(
  config: FleetConfig | null,
  host: string | undefined,
  fetcher: FleetFetch = fetch,
): Promise<StudioFleetSnapshot> {
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
        try {
          machineName = (await checkIdentity(fetcher, target)).label;
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
          status,
          pairingConfigured: Boolean(target.managementToken),
          ...(machineName === undefined ? {} : { machineName }),
        };
      }),
    ),
  };
}
export async function connectFleet(
  config: FleetConfig | null,
  id: string,
  callerScopes: ReadonlySet<AuthEnvironmentScope>,
  fetcher: FleetFetch = fetch,
): Promise<StudioFleetConnectResult> {
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
  await checkIdentity(fetcher, target);
  let result: unknown;
  try {
    result = await jsonRequest(fetcher, target, "/api/auth/pairing-token", {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.managementToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ label: "Private fleet browser", scopes }),
    });
  } catch {
    // Name the cause when the token itself is too narrow: re-adding the
    // same line will never work, a new invitation will.
    await assertManagementTokenCanPair(
      fetcher,
      { url: target.url, managementToken: target.managementToken },
      scopes,
    );
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
    host: target.url,
    pairingCode: result.credential,
    expiresAt: result.expiresAt,
    scopes,
  };
}
