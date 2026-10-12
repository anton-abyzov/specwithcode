import {
  createAdvertisedEndpoint,
  type CreateAdvertisedEndpointInput,
} from "@specweave-studio/shared/advertisedEndpoint";
import {
  DesktopServerExposureModeSchema,
  type AdvertisedEndpoint,
  type AdvertisedEndpointProvider,
  type DesktopServerExposureMode,
  type DesktopServerExposureState,
} from "@specweave-studio/contracts";
import {
  ensureTailscaleServe,
  findTailscaleServeRouteForLocalPort,
  isTailscaleIpv4Address,
  readTailscaleServeRoutes,
  readTailscaleStatus,
  type TailscaleServeRoute,
} from "@specweave-studio/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";

const TAILSCALE_STATUS_CACHE_TTL = Duration.seconds(60);

const DESKTOP_LOOPBACK_HOST = "127.0.0.1";
const DESKTOP_LAN_BIND_HOST = "0.0.0.0";

interface ResolvedDesktopServerExposure {
  readonly mode: DesktopServerExposureMode;
  readonly bindHost: string;
  readonly localHttpUrl: string;
  readonly localWsUrl: string;
  readonly endpointUrl: string | null;
  readonly advertisedHost: string | null;
}

interface DesktopAdvertisedEndpointInput {
  readonly port: number;
  readonly exposure: ResolvedDesktopServerExposure;
  readonly customHttpsEndpointUrls?: readonly string[];
}

const DESKTOP_CORE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "desktop-core",
  label: "Desktop",
  kind: "core",
  isAddon: false,
};

const DESKTOP_MANUAL_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "manual",
  label: "Manual",
  kind: "manual",
  isAddon: false,
};

const normalizeOptionalHost = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
};

const isUsableLanIpv4Address = (address: string): boolean =>
  !address.startsWith("127.") &&
  !address.startsWith("169.254.") &&
  !isTailscaleIpv4Address(address);

const isHttpsEndpointUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const resolveLanAdvertisedHost = (
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
  explicitHost: string | undefined,
): string | null => {
  const normalizedExplicitHost = normalizeOptionalHost(explicitHost);
  if (normalizedExplicitHost) {
    return normalizedExplicitHost;
  }

  for (const interfaceAddresses of Object.values(networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isUsableLanIpv4Address(address.address)) continue;
      return address.address;
    }
  }

  return null;
};

const resolveDesktopServerExposure = (input: {
  readonly mode: DesktopServerExposureMode;
  readonly port: number;
  readonly networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly advertisedHostOverride?: string;
}): ResolvedDesktopServerExposure => {
  const localHttpUrl = `http://${DESKTOP_LOOPBACK_HOST}:${input.port}`;
  const localWsUrl = `ws://${DESKTOP_LOOPBACK_HOST}:${input.port}`;

  if (input.mode === "local-only") {
    return {
      mode: input.mode,
      bindHost: DESKTOP_LOOPBACK_HOST,
      localHttpUrl,
      localWsUrl,
      endpointUrl: null,
      advertisedHost: null,
    };
  }

  const advertisedHost = resolveLanAdvertisedHost(
    input.networkInterfaces,
    input.advertisedHostOverride,
  );

  return {
    mode: input.mode,
    bindHost: DESKTOP_LAN_BIND_HOST,
    localHttpUrl,
    localWsUrl,
    endpointUrl: advertisedHost ? `http://${advertisedHost}:${input.port}` : null,
    advertisedHost,
  };
};

const createDesktopEndpoint = (
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_CORE_ENDPOINT_PROVIDER,
    source: "desktop-core",
  });

const createManualEndpoint = (
  input: Omit<CreateAdvertisedEndpointInput, "provider" | "source">,
): AdvertisedEndpoint =>
  createAdvertisedEndpoint({
    ...input,
    provider: DESKTOP_MANUAL_ENDPOINT_PROVIDER,
    source: "user",
  });

const resolveDesktopCoreAdvertisedEndpoints = (
  input: DesktopAdvertisedEndpointInput,
): readonly AdvertisedEndpoint[] => {
  const endpoints: AdvertisedEndpoint[] = [
    createDesktopEndpoint({
      id: `desktop-loopback:${input.port}`,
      label: "This machine",
      httpBaseUrl: input.exposure.localHttpUrl,
      reachability: "loopback",
      status: "available",
      description: "Loopback endpoint for this desktop app.",
    }),
  ];

  if (input.exposure.endpointUrl) {
    endpoints.push(
      createDesktopEndpoint({
        id: `desktop-lan:${input.exposure.endpointUrl}`,
        label: "Local network",
        httpBaseUrl: input.exposure.endpointUrl,
        reachability: "lan",
        status: "available",
        isDefault: true,
        description: "Reachable from devices on the same network.",
      }),
    );
  }

  for (const customEndpointUrl of input.customHttpsEndpointUrls ?? []) {
    try {
      const isHttpsEndpoint = isHttpsEndpointUrl(customEndpointUrl);
      endpoints.push(
        createManualEndpoint({
          id: `manual:${customEndpointUrl}`,
          label: isHttpsEndpoint ? "Custom HTTPS" : "Custom endpoint",
          httpBaseUrl: customEndpointUrl,
          reachability: "public",
          ...(isHttpsEndpoint ? ({ hostedHttpsCompatibility: "compatible" } as const) : {}),
          status: "unknown",
          description: isHttpsEndpoint
            ? "User-configured HTTPS endpoint for this desktop backend."
            : "User-configured endpoint for this desktop backend.",
        }),
      );
    } catch {
      // Ignore malformed user-configured endpoints without dropping valid endpoints.
    }
  }

  return endpoints;
};

export class DesktopServerExposureNoNetworkAddressError extends Schema.TaggedError<DesktopServerExposureNoNetworkAddressError>()(
  "DesktopServerExposureNoNetworkAddressError",
  {
    port: Schema.Number,
  },
) {
  override get message(): string {
    return `No reachable network address is available for desktop network access on port ${this.port}.`;
  }
}

export class DesktopServerExposureModePersistenceError extends Schema.TaggedError<DesktopServerExposureModePersistenceError>()(
  "DesktopServerExposureModePersistenceError",
  {
    mode: DesktopServerExposureModeSchema,
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist desktop server exposure mode ${this.mode}.`;
  }
}

export class DesktopTailscaleServePersistenceError extends Schema.TaggedError<DesktopTailscaleServePersistenceError>()(
  "DesktopTailscaleServePersistenceError",
  {
    enabled: Schema.Boolean,
    port: Schema.NullOr(Schema.Number),
    cause: Schema.instanceOf(DesktopAppSettings.DesktopSettingsWriteError),
  },
) {
  override get message(): string {
    return `Failed to persist desktop Tailscale Serve settings (enabled: ${this.enabled}, port: ${this.port ?? "unchanged"}).`;
  }
}

export class DesktopTailscaleServeCommandError extends Schema.TaggedError<DesktopTailscaleServeCommandError>()(
  "DesktopTailscaleServeCommandError",
  {
    enabled: Schema.Boolean,
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return this.enabled
      ? `Tailscale could not serve SpecWithCode on HTTPS port ${this.port}. Check that Tailscale is running and HTTPS is enabled for your tailnet.`
      : `Tailscale could not stop serving HTTPS port ${this.port}.`;
  }
}

export class DesktopTailscaleServePortInUseError extends Schema.TaggedError<DesktopTailscaleServePortInUseError>()(
  "DesktopTailscaleServePortInUseError",
  { port: Schema.Number },
) {
  override get message(): string {
    return `Tailscale already serves something else on HTTPS port ${this.port}. Choose another port.`;
  }
}

export const DesktopServerExposureSetModeError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
]);
export type DesktopServerExposureSetModeError = typeof DesktopServerExposureSetModeError.Type;

export const DesktopServerExposureError = Schema.Union([
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
  DesktopTailscaleServePersistenceError,
  DesktopTailscaleServeCommandError,
  DesktopTailscaleServePortInUseError,
]);
export type DesktopServerExposureError = typeof DesktopServerExposureError.Type;

export interface DesktopServerExposureBackendConfig {
  readonly port: number;
  readonly bindHost: string;
  readonly httpBaseUrl: URL;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
}

export interface DesktopServerExposureChange {
  readonly state: DesktopServerExposureState;
  readonly requiresRelaunch: boolean;
}

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  {
    readonly getState: Effect.Effect<DesktopServerExposureState>;
    readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
    readonly configureFromSettings: (input: {
      readonly port: number;
    }) => Effect.Effect<DesktopServerExposureState>;
    readonly setMode: (
      mode: DesktopServerExposureMode,
    ) => Effect.Effect<DesktopServerExposureChange, DesktopServerExposureSetModeError>;
    readonly setTailscaleServeEnabled: (input: {
      readonly enabled: boolean;
      readonly port?: number;
    }) => Effect.Effect<
      DesktopServerExposureChange,
      | DesktopTailscaleServePersistenceError
      | DesktopTailscaleServeCommandError
      | DesktopTailscaleServePortInUseError
    >;
    /**
     * Points exposure at an installed Studio service the desktop attached to
     * instead of starting its own backend.
     */
    readonly attachLocalService: (input: {
      readonly port: number;
    }) => Effect.Effect<DesktopServerExposureState>;
    /** Starts reading Tailscale for the endpoint list and drops the cached answer. */
    readonly checkTailscale: Effect.Effect<DesktopServerExposureState>;
    readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
  }
>()("@specweave-studio/desktop/backend/DesktopServerExposure") {}

interface RuntimeState {
  readonly requestedMode: DesktopServerExposureMode;
  readonly mode: DesktopServerExposureMode;
  readonly port: number;
  readonly bindHost: string;
  readonly localHttpUrl: string;
  readonly localWsUrl: string;
  readonly httpBaseUrl: URL;
  readonly endpointUrl: Option.Option<string>;
  readonly advertisedHost: Option.Option<string>;
  readonly tailscaleServeEnabled: boolean;
  readonly tailscaleServePort: number;
}

// Kept apart from RuntimeState, which settings changes rebuild from scratch.
interface TailscaleLookupState {
  readonly localServiceAttached: boolean;
  readonly checkRequested: boolean;
}

interface ResolvedRuntimeState {
  readonly state: RuntimeState;
  readonly unavailable: boolean;
}

const initialRuntimeState = (): RuntimeState =>
  runtimeStateFromResolvedExposure({
    requestedMode: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
    settings: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
    exposure: resolveDesktopServerExposure({
      mode: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS.serverExposureMode,
      port: 0,
      networkInterfaces: {},
    }),
    port: 0,
  });

// Spawning the Tailscale CLI can show a macOS "Other apps" TCC prompt on Mac
// App Store Tailscale builds, so it waits until the user has opted into some
// form of network access, uses an installed service (which the fleet installer
// exposes through Tailscale Serve), or asks Studio to check.
const readsTailscale = (state: RuntimeState, lookup: TailscaleLookupState): boolean =>
  state.mode === "network-accessible" ||
  state.tailscaleServeEnabled ||
  lookup.localServiceAttached ||
  lookup.checkRequested;

const toContractState = (
  state: RuntimeState,
  lookup: TailscaleLookupState,
): DesktopServerExposureState => ({
  mode: state.mode,
  endpointUrl: Option.getOrNull(state.endpointUrl),
  advertisedHost: Option.getOrNull(state.advertisedHost),
  tailscaleServeEnabled: state.tailscaleServeEnabled,
  tailscaleServePort: state.tailscaleServePort,
  tailscaleChecked: readsTailscale(state, lookup),
  localServiceAttached: lookup.localServiceAttached,
});

const toBackendConfig = (state: RuntimeState): DesktopServerExposureBackendConfig => ({
  port: state.port,
  bindHost: state.bindHost,
  httpBaseUrl: state.httpBaseUrl,
  tailscaleServeEnabled: state.tailscaleServeEnabled,
  tailscaleServePort: state.tailscaleServePort,
});

const toResolvedExposure = (state: RuntimeState): ResolvedDesktopServerExposure => ({
  mode: state.mode,
  bindHost: state.bindHost,
  localHttpUrl: state.localHttpUrl,
  localWsUrl: state.localWsUrl,
  endpointUrl: Option.getOrNull(state.endpointUrl),
  advertisedHost: Option.getOrNull(state.advertisedHost),
});

function runtimeStateFromResolvedExposure(input: {
  readonly requestedMode: DesktopServerExposureMode;
  readonly settings: DesktopAppSettings.DesktopSettings;
  readonly exposure: ResolvedDesktopServerExposure;
  readonly port: number;
}): RuntimeState {
  return {
    requestedMode: input.requestedMode,
    mode: input.exposure.mode,
    port: input.port,
    bindHost: input.exposure.bindHost,
    localHttpUrl: input.exposure.localHttpUrl,
    localWsUrl: input.exposure.localWsUrl,
    httpBaseUrl: new URL(input.exposure.localHttpUrl),
    endpointUrl: Option.fromNullishOr(input.exposure.endpointUrl),
    advertisedHost: Option.fromNullishOr(input.exposure.advertisedHost),
    tailscaleServeEnabled: input.settings.tailscaleServeEnabled,
    tailscaleServePort: input.settings.tailscaleServePort,
  };
}

function resolveRuntimeState(input: {
  readonly requestedMode: DesktopServerExposureMode;
  readonly settings: DesktopAppSettings.DesktopSettings;
  readonly port: number;
  readonly networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly advertisedHostOverride: Option.Option<string>;
}): ResolvedRuntimeState {
  const advertisedHostOverride = Option.getOrUndefined(input.advertisedHostOverride);
  const requestedExposure = resolveDesktopServerExposure({
    mode: input.requestedMode,
    port: input.port,
    networkInterfaces: input.networkInterfaces,
    ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
  });
  const unavailable =
    input.requestedMode === "network-accessible" &&
    requestedExposure.endpointUrl === null &&
    !Object.values(input.networkInterfaces).some((addresses) =>
      addresses?.some(
        (address) =>
          !address.internal && address.family === "IPv4" && isTailscaleIpv4Address(address.address),
      ),
    );
  const exposure = unavailable
    ? resolveDesktopServerExposure({
        mode: "local-only",
        port: input.port,
        networkInterfaces: input.networkInterfaces,
        ...(advertisedHostOverride ? { advertisedHostOverride } : {}),
      })
    : requestedExposure;

  return {
    state: runtimeStateFromResolvedExposure({
      requestedMode: input.requestedMode,
      settings: input.settings,
      exposure,
      port: input.port,
    }),
    unavailable,
  };
}

const requiresBackendRelaunch = (previous: RuntimeState, next: RuntimeState): boolean =>
  previous.port !== next.port ||
  previous.bindHost !== next.bindHost ||
  previous.localHttpUrl !== next.localHttpUrl;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const networkInterfaces = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const stateRef = yield* Ref.make(initialRuntimeState());
  // Each change reads the runtime state, persists settings, then writes the
  // state back. Run them one at a time so a change never writes over another
  // with values it read before that change persisted.
  const changePermit = yield* Semaphore.make(1);

  const lookupRef = yield* Ref.make<TailscaleLookupState>({
    localServiceAttached: false,
    checkRequested: false,
  });

  // Cache the `tailscale status` spawn for the TTL. On macOS, the Mac App
  // Store Tailscale CLI lives inside Tailscale's sandbox container, so each
  // spawn re-triggers the "Other apps" TCC prompt.
  const [cachedReadMagicDnsName, invalidateMagicDnsName] = yield* Effect.cachedInvalidateWithTTL(
    readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    ),
    TAILSCALE_STATUS_CACHE_TTL,
  );
  const [cachedReadServeRoutes, invalidateServeRoutes] = yield* Effect.cachedInvalidateWithTTL(
    readTailscaleServeRoutes.pipe(
      Effect.orElseSucceed((): readonly TailscaleServeRoute[] => []),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    ),
    TAILSCALE_STATUS_CACHE_TTL,
  );
  const invalidateTailscale = Effect.andThen(invalidateMagicDnsName, invalidateServeRoutes);

  const readNetworkInterfaces = networkInterfaces.read;

  const contractState = (state: RuntimeState) =>
    Ref.get(lookupRef).pipe(Effect.map((lookup) => toContractState(state, lookup)));
  const getState = Ref.get(stateRef).pipe(Effect.flatMap(contractState));
  const backendConfig = Ref.get(stateRef).pipe(Effect.map(toBackendConfig));

  const configureFromSettings = Effect.fn("desktop.serverExposure.configureFromSettings")(
    function* ({ port }: { readonly port: number }) {
      yield* Effect.annotateCurrentSpan({ port });
      const settings = yield* desktopSettings.get;
      const currentNetworkInterfaces = yield* readNetworkInterfaces;
      const resolved = resolveRuntimeState({
        requestedMode: settings.serverExposureMode,
        settings,
        port,
        networkInterfaces: currentNetworkInterfaces,
        advertisedHostOverride: config.desktopLanHostOverride,
      });
      yield* Ref.set(stateRef, resolved.state);
      return yield* contractState(resolved.state);
    },
  );

  const setMode = Effect.fn("desktop.serverExposure.setMode")(function* (
    mode: DesktopServerExposureMode,
  ) {
    yield* Effect.annotateCurrentSpan({ mode });
    const previous = yield* Ref.get(stateRef);
    const currentSettings = yield* desktopSettings.get;
    const nextSettings = {
      ...currentSettings,
      serverExposureMode: mode,
    };
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const resolved = resolveRuntimeState({
      requestedMode: mode,
      settings: nextSettings,
      port: previous.port,
      networkInterfaces: currentNetworkInterfaces,
      advertisedHostOverride: config.desktopLanHostOverride,
    });

    if (resolved.unavailable) {
      return yield* new DesktopServerExposureNoNetworkAddressError({ port: previous.port });
    }

    const change = yield* desktopSettings.setServerExposureMode(mode).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopServerExposureModePersistenceError({
            mode,
            cause,
          }),
      ),
    );

    yield* Ref.set(stateRef, resolved.state);
    return {
      state: yield* contractState(resolved.state),
      requiresRelaunch: change.changed || requiresBackendRelaunch(previous, resolved.state),
    };
  }, changePermit.withPermit);

  const ensureServeForAttachedService = Effect.fn(
    "desktop.serverExposure.ensureServeForAttachedService",
  )(function* (input: { readonly localPort: number; readonly servePort: number }) {
    yield* invalidateTailscale;
    const magicDnsName = yield* cachedReadMagicDnsName;
    const routes = yield* cachedReadServeRoutes;
    const existing = magicDnsName
      ? routes.find(
          (route) =>
            route.host === magicDnsName.replace(/\.$/u, "").toLowerCase() &&
            route.servePort === input.servePort,
        )
      : undefined;
    if (existing) {
      const servesThisBackend =
        findTailscaleServeRouteForLocalPort([existing], {
          magicDnsName: existing.host,
          localPort: input.localPort,
        }) !== null;
      if (servesThisBackend) return;
      // Replacing it would silently cut off whatever that route serves.
      return yield* new DesktopTailscaleServePortInUseError({ port: input.servePort });
    }
    yield* ensureTailscaleServe(input).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.mapError(
        (cause) =>
          new DesktopTailscaleServeCommandError({ enabled: true, port: input.servePort, cause }),
      ),
    );
  });

  const setTailscaleServeEnabled = Effect.fn("desktop.serverExposure.setTailscaleServeEnabled")(
    function* (input: { readonly enabled: boolean; readonly port?: number }) {
      yield* Effect.annotateCurrentSpan({
        enabled: input.enabled,
        ...(input.port === undefined ? {} : { port: input.port }),
      });
      // An installed service is not relaunched by the desktop, so the server
      // never reads this setting. Configure Serve for it here, before the
      // setting is saved, so a failure leaves nothing half-applied.
      const lookup = yield* Ref.get(lookupRef);
      if (lookup.localServiceAttached && input.enabled) {
        const current = yield* Ref.get(stateRef);
        yield* ensureServeForAttachedService({
          localPort: current.port,
          servePort: input.port ?? current.tailscaleServePort,
        }).pipe(Effect.ensuring(invalidateTailscale));
      }

      const result = yield* desktopSettings
        .setTailscaleServe({
          enabled: input.enabled,
          port: Option.fromNullishOr(input.port),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DesktopTailscaleServePersistenceError({
                enabled: input.enabled,
                port: input.port ?? null,
                cause,
              }),
          ),
        );

      const nextState = yield* Ref.updateAndGet(stateRef, (current) => ({
        ...current,
        tailscaleServeEnabled: result.settings.tailscaleServeEnabled,
        tailscaleServePort: result.settings.tailscaleServePort,
      }));

      if (lookup.localServiceAttached) {
        // Studio never runs `serve off` for an installed service: the same
        // route may carry the fleet installer's access for other machines.
        return { state: yield* contractState(nextState), requiresRelaunch: false };
      }

      return {
        state: yield* contractState(nextState),
        requiresRelaunch: result.changed,
      };
    },
    changePermit.withPermit,
  );

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const currentNetworkInterfaces = yield* readNetworkInterfaces;
    const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
      port: state.port,
      exposure: toResolvedExposure(state),
      customHttpsEndpointUrls: config.desktopHttpsEndpointUrls,
    });

    const lookup = yield* Ref.get(lookupRef);
    if (!readsTailscale(state, lookup)) {
      return coreEndpoints;
    }

    const tailscaleEndpoints = yield* resolveTailscaleAdvertisedEndpoints({
      port: state.port,
      // An installed service's Serve route belongs to the machine, not to
      // this setting, so it is always looked up and never offered for removal.
      serveEnabled: state.tailscaleServeEnabled && !lookup.localServiceAttached,
      servePort: state.tailscaleServePort,
      networkInterfaces: currentNetworkInterfaces,
      readMagicDnsName: cachedReadMagicDnsName,
      readServeRoutes: cachedReadServeRoutes,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );
    return [...coreEndpoints, ...tailscaleEndpoints];
  }).pipe(Effect.withSpan("desktop.serverExposure.getAdvertisedEndpoints"));

  const attachLocalService = Effect.fn("desktop.serverExposure.attachLocalService")(function* ({
    port,
  }: {
    readonly port: number;
  }) {
    yield* Effect.annotateCurrentSpan({ port });
    const settings = yield* desktopSettings.get;
    // The service binds loopback; its own launcher decides that, not the
    // desktop exposure setting.
    const resolved = resolveRuntimeState({
      requestedMode: "local-only",
      settings,
      port,
      networkInterfaces: yield* readNetworkInterfaces,
      advertisedHostOverride: config.desktopLanHostOverride,
    });
    yield* Ref.set(stateRef, resolved.state);
    yield* Ref.update(lookupRef, (lookup) => ({ ...lookup, localServiceAttached: true }));
    return yield* contractState(resolved.state);
  }, changePermit.withPermit);

  const checkTailscale = Effect.gen(function* () {
    yield* Ref.update(lookupRef, (lookup) => ({ ...lookup, checkRequested: true }));
    yield* invalidateTailscale;
    return yield* getState;
  }).pipe(Effect.withSpan("desktop.serverExposure.checkTailscale"));

  return DesktopServerExposure.of({
    getState,
    backendConfig,
    configureFromSettings,
    setMode,
    setTailscaleServeEnabled,
    attachLocalService,
    checkTailscale,
    getAdvertisedEndpoints,
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);
