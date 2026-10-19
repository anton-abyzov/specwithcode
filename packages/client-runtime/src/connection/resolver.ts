import type {
  AuthClientPresentationMetadata,
  ExecutionEnvironmentDescriptor,
} from "@specweave-studio/contracts";
import { withRelayClientTracing } from "@specweave-studio/shared/relayTracing";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";

import { appendClientConnectionParams } from "../authorization/remote.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  SshConnectionProfile,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  credentialMissingError,
  environmentMismatchError,
  mapRemoteEnvironmentError,
  profileMissingError,
} from "./errors.ts";
import {
  GitHubRoutingPermissions,
  gitHubRoutingConnectionKey,
} from "./githubRoutingPermissions.ts";
import type {
  BearerConnectionTarget,
  ConnectionTarget,
  PreparedConnection,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
} from "./model.ts";
import { ConnectionBlockedError, type ConnectionAttemptError } from "./model.ts";
import * as ConnectionProfileStore from "./profileStore.ts";
import {
  appendOrchestrationProtocol,
  orchestrationProtocolCompatibilityError,
} from "./compatibility.ts";
import { credentialConnectionId } from "./routes.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import { LOOPBACK_SETUP_REQUEST_TIMEOUT_MS } from "./thisMachine.ts";

export class ConnectionResolver extends Context.Service<
  ConnectionResolver,
  {
    readonly prepare: (
      entry: ConnectionCatalogEntry,
      options?: PrepareOptions,
    ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
    /**
     * Authorizes a socket without the orchestration protocol gate, for hosts
     * too old to connect normally. Only update RPCs may run over it.
     */
    readonly prepareForUpdate: (entry: ConnectionCatalogEntry) => Effect.Effect<
      {
        readonly prepared: PreparedConnection;
        readonly descriptor: ExecutionEnvironmentDescriptor;
      },
      ConnectionAttemptError
    >;
  }
>()("@specweave-studio/client-runtime/connection/resolver/ConnectionResolver") {}

export interface PrepareOptions {
  /**
   * The entry is the server on this machine, so each setup request gets the
   * longer this-machine budget: a starved local server answers late, and
   * giving up throws away work it has already started.
   */
  readonly thisMachine?: boolean;
}

/**
 * What a broker hands back: the prepared connection, and the environment
 * descriptor when authorizing it fetched and checked one during this connect,
 * so the resolver does not fetch the same descriptor a second time.
 */
interface BrokeredConnection {
  readonly prepared: PreparedConnection;
  readonly descriptor: ExecutionEnvironmentDescriptor | undefined;
}

function brokered(
  authorized: RemoteEnvironmentAuthorization.AuthorizedRemoteEnvironment,
  target: ConnectionTarget,
): BrokeredConnection {
  return {
    prepared: {
      environmentId: authorized.environmentId,
      label: authorized.label,
      httpBaseUrl: authorized.httpBaseUrl,
      socketUrl: authorized.socketUrl,
      httpAuthorization: authorized.httpAuthorization,
      target,
    },
    descriptor: authorized.descriptor,
  };
}

const isBearerProfile = Schema.is(BearerConnectionProfile);
const isSshProfile = Schema.is(SshConnectionProfile);
const isBearerCredential = Schema.is(BearerConnectionCredential);

function primarySocketUrl(
  target: PrimaryConnectionTarget,
  clientMetadata: AuthClientPresentationMetadata | undefined,
): string {
  const url = new URL(target.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  appendClientConnectionParams(url, clientMetadata, "direct");
  return url.toString();
}

const makePrimaryBroker = Effect.fn("clientRuntime.connection.broker.makePrimary")(function* () {
  const auth = yield* ClientCapabilities.PrimaryEnvironmentAuth;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.primary")(function* (
    target: PrimaryConnectionTarget,
    requestTimeoutMs: number | undefined,
  ) {
    const bearerToken = yield* auth.bearerToken;
    if (Option.isNone(bearerToken)) {
      return {
        prepared: {
          environmentId: target.environmentId,
          label: target.label,
          httpBaseUrl: target.httpBaseUrl,
          socketUrl: primarySocketUrl(target, presentation.metadata),
          httpAuthorization: null,
          target,
        },
        descriptor: undefined,
      } satisfies BrokeredConnection;
    }

    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: target.httpBaseUrl,
      wsBaseUrl: target.wsBaseUrl,
      bearerToken: bearerToken.value,
      connectionMethod: "direct",
      ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    });
    return brokered(authorized, target);
  });
});

const makeBearerBroker = Effect.fn("clientRuntime.connection.broker.makeBearer")(function* () {
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.bearer")(function* (
    entry: ConnectionCatalogEntry & { readonly target: BearerConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Effect.fromOption(entry.profile, () =>
      profileMissingError(target.connectionId),
    );
    if (!isBearerProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not a bearer connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    if (profile.authorization === "studio-connect") {
      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
        directEndpoint: { httpBaseUrl: profile.httpBaseUrl, wsBaseUrl: profile.wsBaseUrl },
      });
      return brokered(authorized, target);
    }
    // A learned route borrows the credential of the route it was learned from.
    const credential = yield* credentials.get(credentialConnectionId(target.connectionId)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(credentialMissingError(target.connectionId)),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (!isBearerCredential(credential)) {
      return yield* credentialMissingError(target.connectionId);
    }
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: profile.httpBaseUrl,
      wsBaseUrl: profile.wsBaseUrl,
      bearerToken: credential.token,
      connectionMethod: "direct",
    });
    return brokered(authorized, target);
  });
});

const makeRelayBroker = Effect.fn("clientRuntime.connection.broker.makeRelay")(function* () {
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fnUntraced(
    function* (target: RelayConnectionTarget) {
      const authorized = yield* remote.authorizeDpop({
        expectedEnvironmentId: target.environmentId,
      });
      return brokered(authorized, target);
    },
    Effect.withSpan("clientRuntime.connection.broker.relay"),
    withRelayClientTracing,
  );
});

const makeSshBroker = Effect.fn("clientRuntime.connection.broker.makeSsh")(function* () {
  const profiles = yield* ConnectionProfileStore.ConnectionProfileStore;
  const ssh = yield* ClientCapabilities.SshEnvironmentGateway;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;

  return Effect.fn("clientRuntime.connection.broker.ssh")(function* (
    entry: ConnectionCatalogEntry & { readonly target: SshConnectionTarget },
  ) {
    const target = entry.target;
    const profile = yield* Effect.fromOption(entry.profile, () =>
      profileMissingError(target.connectionId),
    );
    if (!isSshProfile(profile)) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `Connection profile ${target.connectionId} is not an SSH connection.`,
      });
    }
    if (profile.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: profile.environmentId,
      });
    }
    const prepared = yield* ssh.prepare({
      connectionId: target.connectionId,
      expectedEnvironmentId: target.environmentId,
      target: profile.target,
    });
    const preparedProfile = new SshConnectionProfile({
      connectionId: profile.connectionId,
      environmentId: profile.environmentId,
      label: profile.label,
      target: prepared.bootstrap.target,
    });
    if (
      gitHubRoutingConnectionKey(entry) !==
      gitHubRoutingConnectionKey({ ...entry, profile: Option.some(preparedProfile) })
    ) {
      const permissions = yield* GitHubRoutingPermissions;
      yield* permissions.forget(target.environmentId);
    }
    yield* profiles.put(preparedProfile);
    const authorized = yield* remote.authorizeBearer({
      expectedEnvironmentId: target.environmentId,
      httpBaseUrl: prepared.bootstrap.httpBaseUrl,
      wsBaseUrl: prepared.bootstrap.wsBaseUrl,
      bearerToken: prepared.bearerToken,
      connectionMethod: "ssh",
    });
    return brokered(authorized, target);
  });
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const primary = yield* makePrimaryBroker();
  const bearer = yield* makeBearerBroker();
  const relay = yield* makeRelayBroker();
  const ssh = yield* makeSshBroker();
  const httpClient = yield* HttpClient.HttpClient;

  const authorize = Effect.fn("clientRuntime.connection.broker.authorize")(function* (
    entry: ConnectionCatalogEntry,
    options: PrepareOptions = {},
  ) {
    const target: ConnectionTarget = entry.target;
    const requestTimeoutMs =
      options.thisMachine === true ? LOOPBACK_SETUP_REQUEST_TIMEOUT_MS : undefined;
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
    });
    const brokeredConnection: BrokeredConnection = yield* (() => {
      switch (target._tag) {
        case "PrimaryConnectionTarget":
          return primary(target, requestTimeoutMs);
        case "BearerConnectionTarget":
          return bearer({ ...entry, target });
        case "RelayConnectionTarget":
          return relay(target);
        case "SshConnectionTarget":
          return ssh({ ...entry, target });
      }
    })();
    const prepared = brokeredConnection.prepared;
    // Reuse the descriptor authorization fetched at this address during this
    // connect; fetch one when it did not (a primary without a bearer token, a
    // Studio Connect authorization, or a check that reused a cached
    // descriptor, which may predate a restart onto another protocol).
    const descriptor =
      brokeredConnection.descriptor ??
      (yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: prepared.httpBaseUrl,
        ...(requestTimeoutMs === undefined ? {} : { timeoutMs: requestTimeoutMs }),
      }).pipe(
        Effect.mapError(mapRemoteEnvironmentError),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ));
    if (descriptor.environmentId !== target.environmentId) {
      return yield* environmentMismatchError({
        expected: target.environmentId,
        actual: descriptor.environmentId,
      });
    }
    return { prepared, descriptor };
  });

  const prepare = Effect.fn("clientRuntime.connection.broker.prepare")(function* (
    entry: ConnectionCatalogEntry,
    options?: PrepareOptions,
  ) {
    const { prepared, descriptor } = yield* authorize(entry, options);
    const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
    if (compatibilityError !== null) {
      return yield* compatibilityError;
    }
    return {
      ...prepared,
      socketUrl: appendOrchestrationProtocol(prepared.socketUrl),
    };
  });

  return ConnectionResolver.of({ prepare, prepareForUpdate: (entry) => authorize(entry) });
});

export const layer = Layer.effect(ConnectionResolver, make);
