/**
 * How this machine reaches another one in its fleet: every address the fleet
 * file lists for it, Connect first, each proven to answer as that machine
 * (`/.well-known/studio/environment`, no redirects) before anything is sent.
 * The address that worked is remembered for a few minutes.
 *
 * Credentials (rule R1): a management or MCP token is sent over a
 * SpecWithCode Connect address only when it is bound to this machine's fleet
 * proof key, and then only as `DPoP <token>` with a fresh proof per request.
 * An unbound token goes over the tailnet as a plain bearer, as it always has,
 * and never over Connect.
 */
import { checkIdentity, FleetError, type FleetFetch, type FleetTarget } from "../studioFleet.ts";
import { type FleetOrigin, parseFleetOrigin } from "./fleetOrigin.ts";
import {
  type FleetProofKey,
  FleetProofKeyError,
  readFleetProofKey,
  tokenProofThumbprint,
} from "./fleetProofKey.ts";

export type { FleetOrigin, FleetTransport } from "./fleetOrigin.ts";

/**
 * How long an address stays preferred and its identity trusted, counted from
 * the identity check that proved it. Traffic never extends it: a machine that
 * fell back to the tailnet tries Connect again, and every address has its
 * `/.well-known` identity proven again, at least this often.
 */
export const FLEET_ADDRESS_TTL_MS = 5 * 60_000;

/** Per-process memory of which address answered as which machine. */
export interface FleetAddressBook {
  readonly preferred: (machineKey: string, now: number) => string | undefined;
  readonly remember: (machineKey: string, origin: string, now: number) => void;
  readonly identityFresh: (machineKey: string, origin: string, now: number) => boolean;
  readonly forget: (machineKey: string, origin?: string) => void;
}

export function makeFleetAddressBook(ttlMs = FLEET_ADDRESS_TTL_MS): FleetAddressBook {
  const answered = new Map<string, { readonly origin: string; readonly at: number }>();
  const identities = new Map<string, number>();
  const identityKey = (machineKey: string, origin: string) => `${machineKey}\u0000${origin}`;
  return {
    preferred: (machineKey, now) => {
      const entry = answered.get(machineKey);
      return entry !== undefined && now - entry.at < ttlMs ? entry.origin : undefined;
    },
    remember: (machineKey, origin, now) => {
      answered.set(machineKey, { origin, at: now });
      identities.set(identityKey(machineKey, origin), now);
      // A long-lived server must not grow without bound.
      if (identities.size > 256) {
        for (const [key, at] of identities) if (now - at >= ttlMs) identities.delete(key);
      }
    },
    identityFresh: (machineKey, origin, now) => {
      const at = identities.get(identityKey(machineKey, origin));
      return at !== undefined && now - at < ttlMs;
    },
    forget: (machineKey, origin) => {
      const entry = answered.get(machineKey);
      if (origin === undefined || entry?.origin === origin) answered.delete(machineKey);
      if (origin !== undefined) identities.delete(identityKey(machineKey, origin));
      else
        for (const key of identities.keys())
          if (key.startsWith(`${machineKey}\u0000`)) identities.delete(key);
    },
  };
}

/** What fleet calls go through: a fetch, this machine's proof key (if any) and the address book. */
export interface FleetLink {
  readonly fetch: FleetFetch;
  readonly proofKey: () => Promise<FleetProofKey | null>;
  readonly book: FleetAddressBook;
  readonly now?: () => number;
}

const noKey = async () => null;

/** A bare fetch is a link with no proof key and its own address book (tests, one-off calls). */
export const toFleetLink = (value: FleetLink | FleetFetch): FleetLink =>
  typeof value === "function"
    ? { fetch: value, proofKey: noKey, book: makeFleetAddressBook() }
    : value;

/**
 * A link whose proof key is read from `baseDir` when first needed and kept
 * once found. Reading never creates a key: only adding a machine does.
 */
export function makeFleetLink(input: {
  readonly fetch: FleetFetch;
  readonly baseDir: string;
  readonly book?: FleetAddressBook;
}): FleetLink {
  let found: FleetProofKey | undefined;
  return {
    fetch: input.fetch,
    book: input.book ?? makeFleetAddressBook(),
    proofKey: async () => {
      if (found !== undefined) return found;
      const key = await readFleetProofKey(input.baseDir).catch((error: unknown) => {
        if (error instanceof FleetProofKeyError) throw new FleetError("connect-key-missing");
        throw error;
      });
      if (key !== null) found = key;
      return key;
    },
  };
}

type Reachable = Pick<FleetTarget, "url" | "connectUrl" | "environmentId"> & {
  readonly id?: string;
};

/** The machine's addresses: Connect first, with the tailnet retained as fallback. */
export function fleetAddresses(
  target: Pick<FleetTarget, "url" | "connectUrl">,
): ReadonlyArray<FleetOrigin> {
  const addresses: FleetOrigin[] = [];
  for (const value of [target.connectUrl, target.url]) {
    if (value === undefined) continue;
    const parsed = parseFleetOrigin(value);
    if (parsed !== null && !addresses.some((entry) => entry.origin === parsed.origin))
      addresses.push(parsed);
  }
  return addresses;
}

/** An address that answered as the machine; `machineName` when its identity was read just now. */
export type FleetReached = FleetOrigin & { readonly machineName?: string };

/** The address book's key for a machine: its pinned environment id. */
export const fleetMachineKey = (target: Pick<FleetTarget, "environmentId">) =>
  String(target.environmentId);
const machineKeyOf = fleetMachineKey;

/** Why `token` may not be used on `address`, or null when it may. */
async function tokenRefusal(
  link: FleetLink,
  address: FleetOrigin,
  token: string,
): Promise<"connect-unbound" | "connect-key-missing" | null> {
  const bound = tokenProofThumbprint(token);
  if (bound === undefined) return address.transport === "tailnet" ? null : "connect-unbound";
  const key = await link.proofKey().catch(() => null);
  return key !== null && key.thumbprint === bound ? null : "connect-key-missing";
}

/**
 * The first address that answers as `target`: the one that last worked (while
 * fresh), then the configured order (Connect first). With `token`, only
 * addresses that token may be sent to are tried, so an unbound token never
 * leads to a Connect address being contacted at all.
 */
export async function reachFleetMachine(
  value: FleetLink | FleetFetch,
  target: Reachable,
  options: { readonly token?: string; readonly exclude?: ReadonlySet<string> } = {},
): Promise<FleetReached> {
  const link = toFleetLink(value);
  const now = (link.now ?? Date.now)();
  const key = machineKeyOf(target);
  const configured = fleetAddresses(target).filter(
    (address) => !options.exclude?.has(address.origin),
  );
  const preferred = link.book.preferred(key, now);
  const ordered = [
    ...configured.filter((address) => address.origin === preferred),
    ...configured.filter((address) => address.origin !== preferred),
  ];
  let refusal: "connect-unbound" | "connect-key-missing" | null = null;
  const skipped: FleetOrigin[] = [];
  let mismatch = false;
  for (const address of ordered) {
    if (options.token !== undefined) {
      const refused = await tokenRefusal(link, address, options.token);
      if (refused !== null) {
        if (refusal !== "connect-key-missing") refusal = refused;
        if (refused === "connect-unbound") skipped.push(address);
        continue;
      }
    }
    if (link.book.identityFresh(key, address.origin, now)) return address;
    let machineName: string;
    try {
      machineName = (
        await checkIdentity(link.fetch, {
          url: address.origin,
          environmentId: target.environmentId,
        })
      ).label;
    } catch (error) {
      if (error instanceof FleetError && error.kind === "identity-mismatch") mismatch = true;
      link.book.forget(key, address.origin);
      continue;
    }
    link.book.remember(key, address.origin, (link.now ?? Date.now)());
    return { ...address, machineName };
  }
  if (mismatch) throw new FleetError("identity-mismatch");
  if (refusal === "connect-key-missing") throw new FleetError(refusal);
  if (refusal === "connect-unbound") {
    // Say "invite again" only when the Connect address really answers as
    // this machine (checked without any token); a machine that is simply off
    // is unreachable, and asking for a new invitation would mislead.
    for (const address of skipped) {
      try {
        await checkIdentity(link.fetch, {
          url: address.origin,
          environmentId: target.environmentId,
        });
      } catch (error) {
        if (error instanceof FleetError && error.kind === "identity-mismatch")
          throw new FleetError("identity-mismatch");
        continue;
      }
      throw new FleetError("connect-unbound");
    }
  }
  throw new FleetError("unreachable");
}

/**
 * Authorization headers for `method url` on `address`: a plain bearer for an
 * unbound token on the tailnet; `DPoP <token>` and a fresh proof for a token
 * bound to this machine's key, on any address. Anything else throws, so a
 * bearer never goes over a Connect address.
 */
export async function fleetAuthorization(
  value: FleetLink | FleetFetch,
  address: FleetOrigin,
  method: string,
  url: string,
  token: string,
): Promise<Record<string, string>> {
  const link = toFleetLink(value);
  if (new URL(url).origin !== address.origin) throw new FleetError("unreachable");
  const bound = tokenProofThumbprint(token);
  if (bound === undefined) {
    if (address.transport !== "tailnet") throw new FleetError("connect-unbound");
    return { authorization: `Bearer ${token}` };
  }
  const key = await link.proofKey().catch(() => null);
  if (key === null || key.thumbprint !== bound) throw new FleetError("connect-key-missing");
  return {
    authorization: `DPoP ${token}`,
    dpop: await key.proof({ method: method.toUpperCase(), url, accessToken: token }),
  };
}

export type FleetRequestInit = Omit<RequestInit, "redirect" | "signal"> & {
  readonly token?: string;
  /** Safe to send again: a fetch that threw before any answer moves on to the next address. */
  readonly idempotent?: boolean;
  readonly timeoutMs?: number;
};

/**
 * Reaches `target` and sends `path` there, with `token` authorized for the
 * address used. Any HTTP answer marks that address as the one that works. A
 * request that may have been delivered is never sent again elsewhere unless
 * `idempotent`.
 */
export async function fleetRequest(
  value: FleetLink | FleetFetch,
  target: Reachable,
  path: string,
  init: FleetRequestInit = {},
): Promise<{ readonly response: Response; readonly address: FleetOrigin }> {
  const link = toFleetLink(value);
  const { token, idempotent, timeoutMs, headers, ...rest } = init;
  const key = machineKeyOf(target);
  const exclude = new Set<string>();
  for (;;) {
    const address = await reachFleetMachine(link, target, {
      ...(token === undefined ? {} : { token }),
      exclude,
    });
    const url = `${address.origin}${path}`;
    const merged: Record<string, string> = Object.fromEntries(new Headers(headers));
    if (token !== undefined)
      Object.assign(
        merged,
        await fleetAuthorization(link, address, rest.method ?? "GET", url, token),
      );
    let response: Response;
    try {
      response = await link.fetch(url, {
        ...rest,
        headers: merged,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs ?? 5000),
      });
    } catch {
      link.book.forget(key, address.origin);
      exclude.add(address.origin);
      if (idempotent && fleetAddresses(target).some((entry) => !exclude.has(entry.origin)))
        continue;
      throw new FleetError("unreachable");
    }
    // `reachFleetMachine` already remembered this address when it proved its
    // identity; an answer here must not extend that.
    return { response, address };
  }
}
