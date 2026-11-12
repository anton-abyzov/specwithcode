import {
  type AdvertisedEndpoint,
  type AuthGrantScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  type DesktopBridge,
  type DesktopWslState,
} from "@specweave-studio/contracts";

/**
 * Operating terminals without being able to list them leaves a client
 * allocating a fresh shell for every script run it cannot see, so the pairing
 * form keeps `terminal:read` alongside `terminal:operate`.
 */
export function togglePairingScopeSelection(
  current: ReadonlyArray<AuthGrantScope>,
  scope: AuthGrantScope,
  checked: boolean,
): ReadonlyArray<AuthGrantScope> {
  const without = (scopes: ReadonlyArray<AuthGrantScope>) =>
    scopes.filter((currentScope) => currentScope !== scope);
  if (!checked) {
    return scope === AuthTerminalReadScope
      ? without(current).filter((currentScope) => currentScope !== AuthTerminalOperateScope)
      : without(current);
  }
  const next = [...without(current), scope];
  return scope === AuthTerminalOperateScope && !next.includes(AuthTerminalReadScope)
    ? [...next, AuthTerminalReadScope]
    : next;
}

/** A missing access list says nothing about whether other clients exist. */
export function canRevokeOtherClients(
  clientSessions: ReadonlyArray<{ readonly current: boolean }> | null,
): boolean {
  return clientSessions === null || clientSessions.some((session) => !session.current);
}

/** How long a sign-in may go without a connection before Revoke unused offers it. */
export const UNUSED_CLIENT_AFTER_MS = 24 * 60 * 60_000;
/** Sign-ins a person paired by link or by code. Fleet keys, worker grants and Connect are not these. */
const PAIRED_CLIENT_SUBJECTS: ReadonlySet<string> = new Set(["one-time-token", "device-approval"]);
/** The label another machine of the fleet pairs under (`studioFleet.ts`); a second guard beside its principal. */
const FLEET_BROWSER_LABEL = "Private fleet browser";

/** One authorized client, flattened to what the unused rule reads. */
export interface UnusedClientCandidate<Id extends string = string> {
  readonly sessionId: Id;
  readonly subject: string;
  /** The label the client paired under, when it gave one. */
  readonly label: string | undefined;
  readonly deviceType: string;
  /** Who the server established the client to be; "coordinator" is another machine of the fleet. */
  readonly principalKind: string | undefined;
  readonly issuedAt: string;
  /** When it last connected, or, once its last connection closed, when that was. */
  readonly lastConnectedAt: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}

/**
 * The sign-ins Revoke unused removes: paired by link or code, from a computer's
 * browser or app, connected at least once and with no connection for a day.
 * Headless checks leave these behind by the dozen.
 *
 * Kept whatever their age, because disuse cannot be shown or re-pairing is
 * costly: this app, a connected client, phones and tablets, the fleet's
 * machines, management keys, worker grants, Connect sign-ins (they expire by
 * themselves), a client of an unknown kind or a script (`bot`, `unknown`), and
 * one that never opened a connection: the server records connections, not
 * plain requests, so a script that only makes requests looks never used.
 */
export function unusedClientSessions<Session extends UnusedClientCandidate>(
  sessions: ReadonlyArray<Session>,
  now: number,
): ReadonlyArray<Session> {
  return sessions.filter((session) => {
    if (session.current || session.connected) return false;
    if (!PAIRED_CLIENT_SUBJECTS.has(session.subject)) return false;
    if (session.deviceType !== "desktop") return false;
    if (session.principalKind === "coordinator" || session.label === FLEET_BROWSER_LABEL)
      return false;
    if (session.lastConnectedAt === null) return false;
    const lastSeen = Date.parse(session.lastConnectedAt);
    // An unreadable time is not proof of disuse.
    return Number.isFinite(lastSeen) && now - lastSeen >= UNUSED_CLIENT_AFTER_MS;
  });
}

export interface RevokeUnusedResult {
  readonly revoked: number;
  readonly failed: number;
  /** Left alone: no longer unused by the time its turn came. */
  readonly skipped: number;
  /** The first failure's message, for the notice. */
  readonly error: string | null;
}

/**
 * Revokes a few at a time: one request per sign-in, since the server has no
 * bulk call for a subset. `stillWanted` is asked right before each request.
 */
export async function revokeClientSessions<Id extends string>(
  sessionIds: ReadonlyArray<Id>,
  revoke: (sessionId: Id) => Promise<void>,
  stillWanted: (sessionId: Id) => boolean = () => true,
  concurrency = 4,
): Promise<RevokeUnusedResult> {
  let revoked = 0;
  let failed = 0;
  let skipped = 0;
  let error: string | null = null;
  for (let start = 0; start < sessionIds.length; start += concurrency) {
    const chunk = sessionIds.slice(start, start + concurrency).filter(stillWanted);
    skipped += Math.min(concurrency, sessionIds.length - start) - chunk.length;
    const settled = await Promise.allSettled(chunk.map((sessionId) => revoke(sessionId)));
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        revoked += 1;
        continue;
      }
      failed += 1;
      error ??=
        outcome.reason instanceof Error ? outcome.reason.message : "Could not revoke a sign-in.";
    }
  }
  return { revoked, failed, skipped, error };
}

/**
 * Revoke unused, start to end. The owner confirms a number, so nothing beyond
 * the sign-ins counted then is revoked, and each is checked against the newest
 * list again before its request: a client that connects while the question is
 * open, or while the others are being revoked, is left alone. Null when
 * nothing was asked or the owner said no.
 */
export async function revokeUnusedClients<Id extends string>(input: {
  /** The newest list; null while it is unknown. */
  readonly sessions: () => ReadonlyArray<UnusedClientCandidate<Id>> | null;
  readonly now: () => number;
  readonly confirm: (count: number) => Promise<boolean>;
  readonly revoke: (sessionId: Id) => Promise<void>;
}): Promise<RevokeUnusedResult | null> {
  const unusedNow = () =>
    new Set(
      unusedClientSessions(input.sessions() ?? [], input.now()).map((session) => session.sessionId),
    );
  const asked = [...unusedNow()];
  if (asked.length === 0) return null;
  if (!(await input.confirm(asked.length))) return null;
  return revokeClientSessions(asked, input.revoke, (sessionId) => unusedNow().has(sessionId));
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

/**
 * A QR code encoding a loopback URL makes the scanning device dial itself, so
 * loopback endpoints stay copyable from the endpoint menu but are never
 * offered as QR targets.
 */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

export function isWslSettingsRowVisible(input: {
  readonly state: DesktopWslState | null;
  readonly error: string | null;
}): boolean {
  const { state, error } = input;
  return state ? state.available || state.enabled || state.wslOnly : error !== null;
}

export type QrEndpointOption = {
  /** Unique per endpoint instance (AdvertisedEndpoint.id); safe as a React key. */
  readonly id: string;
  /**
   * Stable per endpoint *type* (endpointDefaultPreferenceKey). Multiple
   * endpoints can share one, so it is only used to match the saved default.
   */
  readonly preferenceKey: string;
  /** False for endpoints that stay copyable but must never render as a QR. */
  readonly qrShareable: boolean;
};

/**
 * Resolves which endpoint the share panel shows: the user's explicit pick,
 * else the saved default endpoint, else the first QR-shareable option (so the
 * panel never opens on a loopback QR), else the first option. A stale
 * selectedId (endpoint disappeared) falls back rather than blanking the panel.
 */
export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}

export type TailscaleHttpsRowState =
  /** Tailscale was not read yet; the user has to ask, because it can prompt. */
  | { readonly kind: "unchecked" }
  /** Tailscale was read and gave no MagicDNS name: not installed, stopped, or MagicDNS off. */
  | { readonly kind: "not-found" }
  /** Studio can set Serve up for this backend. */
  | { readonly kind: "off"; readonly endpoint: AdvertisedEndpoint }
  /** Studio set Serve up and it answers. */
  | { readonly kind: "on"; readonly endpoint: AdvertisedEndpoint }
  /** A route someone else configured serves this backend; Studio leaves it alone. */
  | { readonly kind: "outside-studio"; readonly endpoint: AdvertisedEndpoint }
  /** A route someone else configured points here but does not answer. */
  | { readonly kind: "outside-studio-unreachable"; readonly endpoint: AdvertisedEndpoint };

/**
 * What the Tailscale HTTPS row shows. `tailscaleChecked` is undefined on older
 * desktop builds, which only look Tailscale up once network access is on, so
 * a missing endpoint there means it was not found.
 */
export function resolveTailscaleHttpsRowState(input: {
  readonly endpoint: AdvertisedEndpoint | null;
  readonly tailscaleChecked: boolean | undefined;
}): TailscaleHttpsRowState {
  const { endpoint } = input;
  if (!endpoint) {
    return input.tailscaleChecked === false ? { kind: "unchecked" } : { kind: "not-found" };
  }
  const available = endpoint.status === "available";
  if (endpoint.managedOutsideStudio === true) {
    return available
      ? { kind: "outside-studio", endpoint }
      : { kind: "outside-studio-unreachable", endpoint };
  }
  return available ? { kind: "on", endpoint } : { kind: "off", endpoint };
}

/** Studio may turn off only a Serve route it set up itself. */
export function canDisableTailscaleHttpsEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status === "available" && endpoint.managedOutsideStudio !== true;
}
