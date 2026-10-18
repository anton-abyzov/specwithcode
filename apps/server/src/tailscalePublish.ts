/**
 * Publishing a running server on this machine's own Tailscale name.
 *
 * Shared by `specweave-studio pair --tailscale`, `specweave-studio fleet
 * invite` and the in-app invitation (Settings > Connections), so all three
 * decide the same way whether a Serve mapping is safe to (re)configure: only
 * an unreachable port, or a mapping already fronting this exact environment.
 * Any other responder keeps its mapping.
 */
import { ExecutionEnvironmentDescriptor } from "@specweave-studio/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  ensureTailscaleServe,
  readTailscaleStatus,
} from "@specweave-studio/tailscale";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { PersistedServerRuntimeState } from "./serverRuntimeState.ts";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "./startupAccess.ts";

const WELL_KNOWN_ENVIRONMENT_PATH = "/.well-known/studio/environment";
const PROBE_TIMEOUT = Duration.millis(2_500);
// Tailscale provisions an HTTPS certificate on the first request to a fresh
// serve mapping, which can take a few seconds.
const TAILSCALE_PROBE_ATTEMPTS = 5;
const TAILSCALE_PROBE_RETRY_DELAY = Duration.seconds(1);

// Each tailscale failure gets its own class (same reasoning as
// scripts/lib/dev-share.ts): distinct caller-visible message, distinct remedy.
export class TailscaleUnavailableError extends Schema.TaggedError<TailscaleUnavailableError>()(
  "TailscaleUnavailableError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not talk to Tailscale. Is tailscaled running? Try `tailscale status`.";
  }
}

export class MagicDnsNameMissingError extends Schema.TaggedError<MagicDnsNameMissingError>()(
  "MagicDnsNameMissingError",
  {},
) {
  override get message(): string {
    return "This machine has no MagicDNS name. Run `tailscale up` and enable MagicDNS.";
  }
}

export class ServesOtherEnvironmentError extends Schema.TaggedError<ServesOtherEnvironmentError>()(
  "ServesOtherEnvironmentError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `Tailscale Serve on HTTPS port ${String(this.servePort)} already fronts a different SpecWithCode server. Pass --tailscale-serve-port to publish this one on another port.`;
  }
}

export class TailscaleServeFailedError extends Schema.TaggedError<TailscaleServeFailedError>()(
  "TailscaleServeFailedError",
  { servePort: Schema.Number, cause: Schema.Defect() },
) {
  override get message(): string {
    return `tailscale serve failed for HTTPS port ${String(this.servePort)}. Run \`tailscale serve --https=${String(this.servePort)} --bg <local-url>\` by hand to see why.`;
  }
}

export class ServePortOccupiedError extends Schema.TaggedError<ServePortOccupiedError>()(
  "ServePortOccupiedError",
  { servePort: Schema.Number },
) {
  override get message(): string {
    return `HTTPS port ${String(this.servePort)} on the tailnet already serves something that is not a SpecWithCode server. Pass --tailscale-serve-port to publish this one on another port.`;
  }
}

export class DevServerNotProxiableError extends Schema.TaggedError<DevServerNotProxiableError>()(
  "DevServerNotProxiableError",
  { devUrl: Schema.String },
) {
  override get message(): string {
    return `Tailscale Serve can only proxy plain-HTTP local targets, and this dev server runs at ${this.devUrl}. Pair without --tailscale instead.`;
  }
}

export type TailscalePublishError =
  | TailscaleUnavailableError
  | MagicDnsNameMissingError
  | ServesOtherEnvironmentError
  | TailscaleServeFailedError
  | ServePortOccupiedError
  | DevServerNotProxiableError;

const isDevServerNotProxiableError = Schema.is(DevServerNotProxiableError);

/**
 * The local endpoint Tailscale Serve should proxy to. Dev servers are
 * single-origin, so the web dev server's port is the one to publish; the
 * backend rides along behind Vite's proxy. Serve targets are always plain
 * HTTP, so an HTTPS dev URL cannot be proxied and is rejected.
 */
export const resolveTailscaleLocalTarget = (
  state: Pick<PersistedServerRuntimeState, "devUrl" | "host" | "port">,
): { readonly localPort: number; readonly localHost?: string } | DevServerNotProxiableError => {
  if (state.devUrl !== undefined) {
    const devUrl = new URL(state.devUrl);
    if (devUrl.protocol !== "http:") {
      return new DevServerNotProxiableError({ devUrl: state.devUrl });
    }
    const localPort = devUrl.port.length > 0 ? Number.parseInt(devUrl.port, 10) : 80;
    return isLoopbackHost(devUrl.hostname)
      ? { localPort }
      : { localPort, localHost: devUrl.hostname };
  }
  // A server bound to one specific interface does not answer on loopback, so
  // the proxy has to target that interface directly.
  if (state.host !== undefined && !isWildcardHost(state.host) && !isLoopbackHost(state.host)) {
    return { localPort: state.port, localHost: formatHostForUrl(state.host) };
  }
  return { localPort: state.port };
};

/**
 * Three outcomes, because they drive different decisions: a SpecWithCode
 * descriptor (pair with it), nothing answering (safe to configure Tailscale
 * Serve), or something answering that is not a SpecWithCode server (do NOT
 * overwrite its mapping).
 */
export type EnvironmentProbeResult =
  | { readonly _tag: "descriptor"; readonly descriptor: ExecutionEnvironmentDescriptor }
  | { readonly _tag: "unreachable" }
  | { readonly _tag: "not-a-studio-server" };

export const probeEnvironmentDescriptor = (
  baseUrl: string,
): Effect.Effect<EnvironmentProbeResult, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(new URL(WELL_KNOWN_ENVIRONMENT_PATH, baseUrl).toString());
    const response = yield* client.execute(request).pipe(
      Effect.timeout(PROBE_TIMEOUT),
      // Transport failure or timeout: nothing (reachable) is listening there.
      Effect.mapError(() => ({ _tag: "unreachable" }) as const),
    );
    // Bad-gateway family means a proxy (Tailscale Serve) answered for a
    // backend that is gone — a stale mapping, not a live occupant. Treating
    // it as unreachable lets a publish repair its own mapping after the
    // server's port changed.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return { _tag: "unreachable" } as const;
    }
    // Anything else that answered HTTP but not with a valid descriptor is
    // some other service.
    const descriptor = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(ExecutionEnvironmentDescriptor)),
      Effect.mapError(() => ({ _tag: "not-a-studio-server" }) as const),
    );
    return { _tag: "descriptor", descriptor } as const;
  }).pipe(Effect.catch((outcome) => Effect.succeed(outcome)));

const awaitEnvironmentDescriptor = Effect.fn(function* (baseUrl: string) {
  let last: EnvironmentProbeResult = { _tag: "unreachable" };
  for (let attempt = 0; attempt < TAILSCALE_PROBE_ATTEMPTS; attempt += 1) {
    last = yield* probeEnvironmentDescriptor(baseUrl);
    if (last._tag === "descriptor") {
      return last;
    }
    yield* Effect.sleep(TAILSCALE_PROBE_RETRY_DELAY);
  }
  return last;
});

/**
 * Publishes the server described by `state` on this machine's MagicDNS name
 * at `servePort`, and returns its tailnet HTTPS base URL with notes for the
 * person. Never replaces a Serve mapping that fronts another server or
 * something that is not a SpecWithCode server.
 */
export const publishOnTailscale = Effect.fn("tailscale.publishOnTailscale")(function* (input: {
  readonly environmentId: string;
  readonly state: Pick<PersistedServerRuntimeState, "devUrl" | "host" | "port">;
  readonly servePort: number;
}) {
  const notes: Array<string> = [];
  const status = yield* readTailscaleStatus.pipe(
    Effect.mapError((cause) => new TailscaleUnavailableError({ cause })),
  );
  if (status.magicDnsName === null) {
    return yield* new MagicDnsNameMissingError();
  }
  const baseUrl = buildTailscaleHttpsBaseUrl({
    magicDnsName: status.magicDnsName,
    servePort: input.servePort,
  });

  // Only an unreachable port, or a mapping already fronting this exact
  // environment, is safe to (re)configure. Any other responder — SpecWithCode
  // or not — must not have its mapping silently replaced.
  const existing = yield* probeEnvironmentDescriptor(baseUrl);
  if (existing._tag === "descriptor") {
    if (existing.descriptor.environmentId !== input.environmentId) {
      return yield* new ServesOtherEnvironmentError({ servePort: input.servePort });
    }
    // Matching environment id proves the mapping reaches this server, but
    // not through which port: for a dev server it may front the backend
    // (whose /.well-known also answers) while /pair only renders through
    // the web origin. Reuse as-is for regular servers; fall through and
    // repoint our own mapping at the web port for dev servers.
    if (input.state.devUrl === undefined) {
      return { baseUrl, notes, configured: false };
    }
  }
  if (existing._tag === "not-a-studio-server") {
    return yield* new ServePortOccupiedError({ servePort: input.servePort });
  }

  const localTarget = resolveTailscaleLocalTarget(input.state);
  if (isDevServerNotProxiableError(localTarget)) {
    return yield* localTarget;
  }
  yield* ensureTailscaleServe({
    localPort: localTarget.localPort,
    servePort: input.servePort,
    ...(localTarget.localHost !== undefined ? { localHost: localTarget.localHost } : {}),
  }).pipe(
    Effect.mapError(
      (cause) => new TailscaleServeFailedError({ servePort: input.servePort, cause }),
    ),
  );
  notes.push(
    `Tailscale Serve now maps ${baseUrl} to this server and persists across restarts. Remove it with \`tailscale serve --https=${String(input.servePort)} off\`.`,
  );

  const probed = yield* awaitEnvironmentDescriptor(baseUrl);
  if (probed._tag === "descriptor") {
    if (probed.descriptor.environmentId !== input.environmentId) {
      return yield* new ServesOtherEnvironmentError({ servePort: input.servePort });
    }
  } else {
    notes.push(
      "The HTTPS endpoint has not answered yet. First use can take a moment while Tailscale provisions certificates.",
    );
  }
  return { baseUrl, notes, configured: true };
});
