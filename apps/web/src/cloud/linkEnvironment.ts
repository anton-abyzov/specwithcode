import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import {
  EnvironmentCloudEndpointUnavailableError,
  type EnvironmentCloudLinkStateResult,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentId,
  WS_METHODS,
} from "@specweave-studio/contracts";
import {
  type RelayEnvironmentLinkResponse,
  type RelayManagedEndpointProviderKind,
} from "@specweave-studio/contracts/relay";
import { EnvironmentRegistry } from "@specweave-studio/client-runtime/connection";
import { request, runStream } from "@specweave-studio/client-runtime/rpc";
import { makeEnvironmentHttpApiClient } from "@specweave-studio/client-runtime/rpc";
import { ManagedRelay } from "@specweave-studio/client-runtime/relay";

import * as PrimaryEnvironmentHttpLayer from "../environments/primary/httpLayer";
import { resolveCloudPublicConfig } from "./publicConfig";
import {
  finishRelayClientInstall,
  reportRelayClientInstallProgress,
  requestRelayClientInstallConfirmation,
  startRelayClientInstallInline,
} from "./relayClientInstallDialog";

function relayUrl(): string | null {
  return resolveCloudPublicConfig().relayUrl;
}

export class CloudEnvironmentLinkError extends Data.TaggedError("CloudEnvironmentLinkError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly traceId?: string;
}> {}

const relayClientRpcError = (message: string) => (cause: unknown) =>
  new CloudEnvironmentLinkError({
    message,
    cause,
  });

/**
 * Whether a missing relay client is installed after a question, or straight
 * away because the person already agreed to the link that needs it.
 */
export type RelayClientInstallConsent = "ask" | "agreed";

/** Longer than this and an install is not slow but stuck: the link then fails with a reason. */
export const RELAY_CLIENT_INSTALL_TIMEOUT = "5 minutes";

/** What the machine said went wrong with the install, when it said anything. */
function relayClientInstallFailure(cause: unknown): string | null {
  if (typeof cause !== "object" || cause === null) return null;
  if (
    "_tag" in cause &&
    cause._tag === "RelayClientInstallFailedError" &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return "cause" in cause ? relayClientInstallFailure(cause.cause) : null;
}

function ensureRelayClientAvailable(
  environmentId: EnvironmentId,
  consent: RelayClientInstallConsent,
): Effect.Effect<void, CloudEnvironmentLinkError, EnvironmentRegistry.EnvironmentRegistry> {
  return Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const status = yield* registry
      .run(environmentId, request(WS_METHODS.cloudGetRelayClientStatus, {}))
      .pipe(Effect.mapError(relayClientRpcError("Could not check relay client availability.")));
    if (status.status === "available") return;
    if (status.status === "unsupported") {
      return yield* new CloudEnvironmentLinkError({
        message: `SpecWithCode cannot install the relay client automatically on ${status.platform}-${status.arch}.`,
      });
    }

    if (consent === "agreed") {
      yield* Effect.try({
        try: () => startRelayClientInstallInline(status.version),
        catch: relayClientRpcError("Could not start relay client installation."),
      });
    } else {
      const confirmed = yield* Effect.tryPromise({
        try: () => requestRelayClientInstallConfirmation(status.version),
        catch: relayClientRpcError("Could not confirm relay client installation."),
      }).pipe(
        // A link that is given up while the question is open takes the question with it.
        Effect.onInterrupt(() => Effect.sync(finishRelayClientInstall)),
      );
      if (!confirmed) {
        return yield* new CloudEnvironmentLinkError({
          message: "Relay client installation was cancelled.",
        });
      }
    }

    const installed = yield* registry
      .runStream(
        environmentId,
        runStream(WS_METHODS.cloudInstallRelayClient, {}).pipe(
          Stream.tap((event) => Effect.sync(() => reportRelayClientInstallProgress(event))),
        ),
      )
      .pipe(
        Stream.runLast,
        Effect.mapError((cause) => {
          const reason = relayClientInstallFailure(cause);
          return new CloudEnvironmentLinkError({
            message: reason
              ? `Could not install the relay client: ${reason}`
              : "Could not install the relay client.",
            cause,
          });
        }),
        // The machine's install has no end of its own on a network that stops answering.
        Effect.timeoutOrElse({
          duration: RELAY_CLIENT_INSTALL_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new CloudEnvironmentLinkError({
                message:
                  "Installing the relay client took longer than 5 minutes. Check this machine's internet connection, then try again.",
              }),
            ),
        }),
        Effect.ensuring(Effect.sync(finishRelayClientInstall)),
      );
    if (Option.isNone(installed) || installed.value.type !== "complete") {
      return yield* new CloudEnvironmentLinkError({
        message: "The relay client install completed without a final status.",
      });
    }
    const installedStatus = installed.value.status;
    if (installedStatus.status !== "available") {
      return yield* new CloudEnvironmentLinkError({
        message:
          installedStatus.status === "unsupported"
            ? `SpecWithCode cannot install the relay client automatically on ${installedStatus.platform}-${installedStatus.arch}.`
            : "The relay client is still unavailable after installation.",
      });
    }
  });
}

const isEnvironmentCloudApiError = Schema.is(
  Schema.Union([
    EnvironmentHttpBadRequestError,
    EnvironmentHttpUnauthorizedError,
    EnvironmentHttpForbiddenError,
    EnvironmentHttpConflictError,
    EnvironmentHttpInternalServerError,
    EnvironmentCloudEndpointUnavailableError,
  ]),
);

function decodedRelayClientError(message: string) {
  return (cause: ManagedRelay.ManagedRelayClientError) => {
    const { detail, traceId } = ManagedRelay.managedRelayFailureDetail(cause);
    return new CloudEnvironmentLinkError({
      message: `${message}: ${detail}`,
      cause,
      ...(traceId ? { traceId } : {}),
    });
  };
}

function findEnvironmentCloudApiError(cause: unknown): { readonly message: string } | null {
  if (isEnvironmentCloudApiError(cause)) {
    return cause;
  }
  if (typeof cause !== "object" || cause === null) {
    return null;
  }
  return "cause" in cause ? findEnvironmentCloudApiError(cause.cause) : null;
}

const environmentApiError = (message: string) => (cause: unknown) => {
  const environmentError = findEnvironmentCloudApiError(cause);
  return new CloudEnvironmentLinkError({
    message: environmentError
      ? `${message.replace(/[.:]$/, "")}: ${environmentError.message}`
      : message,
    cause,
  });
};

function endpointOrigin(httpBaseUrl: string) {
  const url = new URL(httpBaseUrl);
  return {
    localHttpHost: "127.0.0.1",
    localHttpPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
  };
}

const MANAGED_ENDPOINT_PROVIDER_KIND =
  "cloudflare_tunnel" satisfies RelayManagedEndpointProviderKind;

function ensureLinkedEnvironmentMatches(input: {
  readonly expectedEnvironmentId: string;
  readonly expectedProviderKind: RelayManagedEndpointProviderKind;
  readonly link: RelayEnvironmentLinkResponse;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  if (input.link.environmentId !== input.expectedEnvironmentId) {
    return new CloudEnvironmentLinkError({
      message: "Relay returned credentials for a different environment.",
    });
  }
  if (input.link.endpoint.providerKind !== input.expectedProviderKind) {
    return new CloudEnvironmentLinkError({
      message: "Relay returned credentials for a different endpoint provider.",
    });
  }
  return Effect.void;
}

export interface CloudLinkTarget {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export type CloudLinkState = EnvironmentCloudLinkStateResult;

export function readPrimaryCloudLinkState(input: {
  readonly target: CloudLinkTarget;
}): Effect.Effect<CloudLinkState | null, CloudEnvironmentLinkError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(input.target.httpBaseUrl);
    return yield* client.connect
      .linkState({ headers: {} })
      .pipe(Effect.mapError(environmentApiError("Could not read environment cloud link state.")));
  }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layer));
}

export function updatePrimaryCloudPreferences(input: {
  readonly target: CloudLinkTarget;
  readonly publishAgentActivity: boolean;
  readonly holdWebhooksWhileOffline?: boolean;
}): Effect.Effect<CloudLinkState, CloudEnvironmentLinkError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(input.target.httpBaseUrl);
    const { target: _target, ...payload } = input;
    return yield* client.connect
      .preferences({
        headers: {},
        payload,
      })
      .pipe(
        Effect.mapError(environmentApiError("Could not update environment cloud preferences.")),
      );
  }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layer));
}

export function unlinkPrimaryEnvironmentFromCloud(input: {
  readonly target: CloudLinkTarget;
  readonly clerkToken: string | null;
}): Effect.Effect<
  void,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient | ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(input.target.httpBaseUrl);
    yield* client.connect
      .unlink({ headers: {} })
      .pipe(Effect.mapError(environmentApiError("Could not unlink the environment from cloud.")));

    const configuredRelayUrl = relayUrl();
    if (configuredRelayUrl && input.clerkToken) {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      yield* relayClient
        .unlinkEnvironment({
          clerkToken: input.clerkToken,
          environmentId: EnvironmentId.make(input.target.environmentId),
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not revoke cloud environment link after local unlink.", {
              cause,
            }),
          ),
        );
    }
  }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layer));
}

// "publish_only" links the environment to the relay for agent-activity
// publishing alone: no managed tunnel is provisioned, so it can be toggled
// independently of Studio Connect while clients reach the environment out of band.
export type CloudLinkMode = "managed" | "publish_only";

const PUBLISH_ONLY_PROVIDER_KIND = "manual" satisfies RelayManagedEndpointProviderKind;

export function linkPrimaryEnvironmentToCloud(input: {
  readonly target: CloudLinkTarget;
  readonly clerkToken: string;
  readonly mode?: CloudLinkMode;
  /** "ask" unless given: only a caller that shows the install's progress itself may pass "agreed". */
  readonly relayClientInstall?: RelayClientInstallConsent;
}): Effect.Effect<
  void,
  CloudEnvironmentLinkError,
  EnvironmentRegistry.EnvironmentRegistry | HttpClient.HttpClient | ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const configuredRelayUrl = relayUrl();
    if (!configuredRelayUrl) {
      return yield* new CloudEnvironmentLinkError({
        message: "STUDIO_RELAY_URL is not configured.",
      });
    }
    const managedTunnelsEnabled = (input.mode ?? "managed") === "managed";
    const providerKind = managedTunnelsEnabled
      ? MANAGED_ENDPOINT_PROVIDER_KIND
      : PUBLISH_ONLY_PROVIDER_KIND;
    const relayClient = yield* ManagedRelay.ManagedRelayClient;
    const environmentClient = yield* makeEnvironmentHttpApiClient(input.target.httpBaseUrl);
    if (managedTunnelsEnabled) {
      yield* ensureRelayClientAvailable(
        EnvironmentId.make(input.target.environmentId),
        input.relayClientInstall ?? "ask",
      );
    }

    const challenge = yield* relayClient
      .createEnvironmentLinkChallenge({
        clerkToken: input.clerkToken,
        payload: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled,
        },
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(
            `${configuredRelayUrl}/v1/client/environment-link-challenges failed`,
          ),
        ),
      );
    const proof = yield* environmentClient.connect
      .linkProof({
        headers: {},
        payload: {
          challenge: challenge.challenge,
          relayIssuer: configuredRelayUrl,
          endpoint: {
            httpBaseUrl: input.target.httpBaseUrl,
            wsBaseUrl: input.target.wsBaseUrl,
            providerKind,
          },
          origin: endpointOrigin(input.target.httpBaseUrl),
        },
      })
      .pipe(Effect.mapError(environmentApiError("Could not obtain environment link proof.")));
    const link = yield* relayClient
      .linkEnvironment({
        clerkToken: input.clerkToken,
        payload: {
          proof,
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled,
        },
      })
      .pipe(
        Effect.mapError(
          decodedRelayClientError(`${configuredRelayUrl}/v1/client/environment-links failed`),
        ),
      );
    yield* ensureLinkedEnvironmentMatches({
      expectedEnvironmentId: input.target.environmentId,
      expectedProviderKind: providerKind,
      link,
    });

    yield* environmentClient.connect
      .relayConfig({
        headers: {},
        payload: {
          relayUrl: configuredRelayUrl,
          relayIssuer: link.relayIssuer,
          cloudUserId: link.cloudUserId,
          environmentCredential: link.environmentCredential,
          cloudMintPublicKey: link.cloudMintPublicKey,
          endpointRuntime: link.endpointRuntime,
          endpoint: link.endpoint,
        },
      })
      .pipe(Effect.mapError(environmentApiError("Could not configure environment relay access.")));
  }).pipe(Effect.provide(PrimaryEnvironmentHttpLayer.layer));
}
