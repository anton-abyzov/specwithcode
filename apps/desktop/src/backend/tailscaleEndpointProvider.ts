import { createAdvertisedEndpoint } from "@specweave-studio/shared/advertisedEndpoint";
import type { AdvertisedEndpoint, AdvertisedEndpointProvider } from "@specweave-studio/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  findTailscaleServeRouteForLocalPort,
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  probeTailscaleHttpsEndpoint,
  readTailscaleStatus,
  type TailscaleServeRoute,
} from "@specweave-studio/tailscale";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { NetworkInterfaces } from "./DesktopNetworkInterfaces.ts";

export { parseTailscaleMagicDnsName } from "@specweave-studio/tailscale";

const TAILSCALE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

function resolveTailscaleIpAdvertisedEndpoints(input: {
  readonly port: number;
  readonly networkInterfaces: NetworkInterfaces;
}): readonly AdvertisedEndpoint[] {
  const seen = new Set<string>();
  const endpoints: AdvertisedEndpoint[] = [];

  for (const interfaceAddresses of Object.values(input.networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isTailscaleIpv4Address(address.address)) continue;
      if (seen.has(address.address)) continue;
      seen.add(address.address);

      endpoints.push(
        createAdvertisedEndpoint({
          provider: TAILSCALE_ENDPOINT_PROVIDER,
          source: "desktop-addon",
          id: `tailscale-ip:http://${address.address}:${input.port}`,
          label: "Tailscale IP",
          httpBaseUrl: `http://${address.address}:${input.port}`,
          reachability: "private-network",
          status: "available",
          description: "Reachable from devices on the same Tailnet.",
        }),
      );
    }
  }

  return endpoints;
}

const resolveTailscaleMagicDnsAdvertisedEndpoint = Effect.fn(
  "resolveTailscaleMagicDnsAdvertisedEndpoint",
)(function* (input: {
  readonly dnsName: string | null;
  readonly localPort: number;
  readonly serveEnabled: boolean;
  readonly servePort?: number;
  readonly readServeRoutes?: Effect.Effect<
    readonly TailscaleServeRoute[],
    never,
    ChildProcessSpawner.ChildProcessSpawner
  >;
  readonly probe?: (baseUrl: string) => Effect.Effect<boolean, never, HttpClient.HttpClient>;
}): Effect.fn.Return<
  Option.Option<AdvertisedEndpoint>,
  never,
  HttpClient.HttpClient | ChildProcessSpawner.ChildProcessSpawner
> {
  if (!input.dnsName) {
    return Option.none();
  }

  // When Studio has not set Serve up itself, a route someone else added (the
  // fleet installer, or `tailscale serve` by hand) may already forward HTTPS
  // to this backend. Show that route as it is instead of offering setup.
  const outsideRoute =
    !input.serveEnabled && input.readServeRoutes
      ? findTailscaleServeRouteForLocalPort(yield* input.readServeRoutes, {
          magicDnsName: input.dnsName,
          localPort: input.localPort,
        })
      : null;
  const servePort = outsideRoute?.servePort ?? input.servePort;

  const httpBaseUrl = buildTailscaleHttpsBaseUrl({
    magicDnsName: input.dnsName,
    ...(servePort === undefined ? {} : { servePort }),
  });
  const probe =
    input.probe?.(httpBaseUrl) ??
    probeTailscaleHttpsEndpoint({
      baseUrl: httpBaseUrl,
    });
  const isReachable = input.serveEnabled || outsideRoute !== null ? yield* probe : false;

  return Option.some(
    createAdvertisedEndpoint({
      provider: TAILSCALE_ENDPOINT_PROVIDER,
      source: "desktop-addon",
      id: `tailscale-magicdns:${httpBaseUrl}`,
      label: "Tailscale HTTPS",
      httpBaseUrl,
      reachability: "private-network",
      hostedHttpsCompatibility: isReachable ? "compatible" : "requires-configuration",
      status: isReachable ? "available" : "unavailable",
      description: outsideRoute
        ? isReachable
          ? "HTTPS endpoint served by a Tailscale Serve route that SpecWithCode leaves alone."
          : "A Tailscale Serve route points here, but it is not answering."
        : isReachable
          ? "HTTPS endpoint served by Tailscale Serve."
          : "MagicDNS hostname. Configure Tailscale Serve for HTTPS access.",
      ...(outsideRoute ? { managedOutsideStudio: true } : {}),
    }),
  );
});

export const resolveTailscaleAdvertisedEndpoints = Effect.fn("resolveTailscaleAdvertisedEndpoints")(
  function* (input: {
    readonly port: number;
    readonly serveEnabled?: boolean;
    readonly servePort?: number;
    readonly networkInterfaces: NetworkInterfaces;
    readonly statusJson?: string | null;
    readonly readMagicDnsName?: Effect.Effect<
      string | null,
      never,
      ChildProcessSpawner.ChildProcessSpawner
    >;
    readonly readServeRoutes?: Effect.Effect<
      readonly TailscaleServeRoute[],
      never,
      ChildProcessSpawner.ChildProcessSpawner
    >;
    readonly probe?: (baseUrl: string) => Effect.Effect<boolean, never, HttpClient.HttpClient>;
  }): Effect.fn.Return<
    readonly AdvertisedEndpoint[],
    never,
    ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
  > {
    const ipEndpoints = resolveTailscaleIpAdvertisedEndpoints(input);
    const readDnsName =
      input.readMagicDnsName ??
      readTailscaleStatus.pipe(
        Effect.map((status) => status.magicDnsName),
        Effect.orElseSucceed((): string | null => null),
      );
    const dnsName =
      input.statusJson === undefined
        ? yield* readDnsName
        : input.statusJson
          ? yield* parseTailscaleMagicDnsName(input.statusJson).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null;
    const magicDnsEndpoint = yield* resolveTailscaleMagicDnsAdvertisedEndpoint({
      dnsName,
      localPort: input.port,
      serveEnabled: input.serveEnabled === true,
      ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
      ...(input.readServeRoutes === undefined ? {} : { readServeRoutes: input.readServeRoutes }),
      ...(input.probe === undefined ? {} : { probe: input.probe }),
    });

    return Option.match(magicDnsEndpoint, {
      onNone: () => ipEndpoints,
      onSome: (endpoint) => [...ipEndpoints, endpoint],
    });
  },
);
