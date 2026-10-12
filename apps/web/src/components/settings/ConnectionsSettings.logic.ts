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
