import * as CloudflareRetry from "@distilled.cloud/cloudflare/Retry";
import * as Alchemy from "alchemy";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import {
  layer,
  layerDnsClient,
  layerTunnelClient,
  ManagedEndpointDnsClientError,
  ManagedEndpointTunnelClientError,
  normalizeHostname,
} from "./ManagedEndpointProvider.ts";

// The Worker's Cloudflare clients for the managed endpoint provider, each call
// bounded and retried the same way.

// The client's default policy retries transient errors, including "Authentication
// error", 8 times with up to 5s between tries, which outlasts the call limit. A
// persistent failure then surfaced only as a timeout, hiding the real error. Four
// retries over 3.75s still ride out a short auth blip and leave room for its error.
export const CLOUDFLARE_CALL_RETRY: CloudflareRetry.Options = {
  ...(CloudflareRetry.transientOptions.while === undefined
    ? {}
    : { while: CloudflareRetry.transientOptions.while }),
  schedule: Schedule.max([Schedule.exponential(250, 2), Schedule.recurs(4)]),
};

export const limitCloudflareCall = <A, E, R>(call: Effect.Effect<A, E, R>) =>
  call.pipe(CloudflareRetry.policy(CLOUDFLARE_CALL_RETRY), Effect.timeout("8 seconds"));

export const layerCloudflareBindings = (
  tunnelClient: Cloudflare.Tunnel.ReadWriteTunnelClient,
  dnsClient: Cloudflare.DNS.ReadWriteDnsClient,
  alchemyRuntimeContext: Alchemy.BaseRuntimeContext,
) =>
  layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        layerTunnelClient({
          get: (tunnelId) =>
            limitCloudflareCall(tunnelClient.get(tunnelId)).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "get",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          list: (request) =>
            limitCloudflareCall(tunnelClient.list(request)).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "list",
                    ...(request.name === undefined ? {} : { tunnelName: request.name }),
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          create: (request) =>
            limitCloudflareCall(tunnelClient.create(request)).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "create",
                    tunnelName: request.name,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          putConfiguration: (tunnelId, config) =>
            limitCloudflareCall(tunnelClient.putConfiguration(tunnelId, config)).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "put-configuration",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          getToken: (tunnelId) =>
            limitCloudflareCall(tunnelClient.getToken(tunnelId)).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "get-token",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          delete: (tunnelId) =>
            limitCloudflareCall(tunnelClient.delete(tunnelId)).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointTunnelClientError({
                    operation: "delete",
                    tunnelId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
        }),
        layerDnsClient({
          listRecords: (hostname) =>
            limitCloudflareCall(dnsClient.listDnsRecords({ search: hostname })).pipe(
              Effect.map((response) =>
                response.result.filter(
                  (record): record is typeof record & { readonly id: string } =>
                    typeof record.id === "string" &&
                    normalizeHostname(record.name) === normalizeHostname(hostname),
                ),
              ),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "list-records",
                    hostname,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          createRecord: (request) =>
            limitCloudflareCall(dnsClient.createDnsRecord(request)).pipe(
              Effect.map((response) => ({ id: response.id })),
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "create-record",
                    hostname: request.name,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          updateRecord: (dnsRecordId, request) =>
            limitCloudflareCall(dnsClient.updateDnsRecord(dnsRecordId, request)).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "update-record",
                    hostname: request.name,
                    dnsRecordId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
          deleteRecord: (dnsRecordId) =>
            limitCloudflareCall(dnsClient.deleteDnsRecord(dnsRecordId)).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedEndpointDnsClientError({
                    operation: "delete-record",
                    dnsRecordId,
                    cause,
                  }),
              ),
              Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
            ),
        }),
      ),
    ),
  );
