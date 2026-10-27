/**
 * How a CLI command reaches the running service without opening its database.
 *
 * A command that needs the running service finds it from the home's
 * `server-runtime.json` (`runningService`, the same pid and start-time check
 * `db reclaim` uses) and calls it over HTTP or its WebSocket with the token
 * the service published for the local CLI (auth/LocalCliCredential.ts). It
 * never inserts a session row of its own: that took a read-write connection
 * to `userdata/statev2.sqlite`, and such a connection deletes `-wal` and
 * `-shm` under a service that has lost its SQLite locks
 * (docs/operations/live-database.md). Commands that still open the database
 * directly (the auth store when no service runs, `project` offline) go through
 * `Sqlite.layerConfigOutsideService`, which refuses while a service runs.
 *
 * @module liveService
 */
import {
  type AuthEnvironmentScope,
  AuthGrantScope,
  EnvironmentHttpApi,
  AUTH_PAIRING_CREDENTIAL_MAX_TTL_SECONDS,
} from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import { LOCAL_CLI_CREDENTIAL_SECRET } from "../auth/LocalCliCredential.ts";
import type * as ServerConfig from "../config.ts";
import { runningServiceOf } from "../persistence/liveServiceOwner.ts";
import type { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { formatHostForUrl, isLoopbackHost, isWildcardHost } from "../startupAccess.ts";
import { probeEnvironmentDescriptor } from "../tailscalePublish.ts";

/**
 * A `--ttl` as the running service's `ttlSeconds` (whole seconds, rounded up).
 * Left out, the service uses its one-time default of five minutes.
 */
export const livePairingTtl = (ttl: Option.Option<Duration.Duration>) => {
  if (Option.isNone(ttl)) return Effect.succeed({});
  const ttlSeconds = Math.ceil(Duration.toMillis(ttl.value) / 1000);
  return ttlSeconds >= 1 && ttlSeconds <= AUTH_PAIRING_CREDENTIAL_MAX_TTL_SECONDS
    ? Effect.succeed({ ttlSeconds })
    : Effect.fail(
        new LiveServiceUnsupportedError({
          reason: `--ttl ${Duration.format(ttl.value)} is outside what the running SpecWithCode issues (1 second to 30 days).`,
        }),
      );
};

export class LiveServiceCredentialError extends Schema.TaggedError<LiveServiceCredentialError>()(
  "LiveServiceCredentialError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export class LiveServiceRequestError extends Schema.TaggedError<LiveServiceRequestError>()(
  "LiveServiceRequestError",
  { reason: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.reason;
  }
}

/** A command, or one of its options, that has no way through the running service. */
export class LiveServiceUnsupportedError extends Schema.TaggedError<LiveServiceUnsupportedError>()(
  "LiveServiceUnsupportedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export type LiveServiceConfig = Pick<
  ServerConfig.ServerConfig["Service"],
  "serverRuntimeStatePath" | "secretsDir" | "environmentIdPath"
>;

/** The service running from this home, if one is (pid and start time checked). */
export const runningService = (config: Pick<LiveServiceConfig, "serverRuntimeStatePath">) =>
  runningServiceOf(config.serverRuntimeStatePath);

/** Says what to do instead, for a refusal that names the service. */
export const liveServiceRefusal = (
  state: Pick<PersistedServerRuntimeState, "pid" | "origin">,
  what: string,
  instead: string,
) =>
  new LiveServiceUnsupportedError({
    reason:
      `SpecWithCode is running (pid ${state.pid}, ${state.origin}). ${what} ` +
      `would need to open its live database, which this CLI does not do while the service runs. ${instead}`,
  });

/**
 * The bearer token the running service published for this machine's CLI.
 * Read from the secrets folder only; nothing is created or changed.
 */
export const readLocalCliToken = Effect.fn("cli.liveService.readLocalCliToken")(function* (
  config: LiveServiceConfig,
  state: Pick<PersistedServerRuntimeState, "pid">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(config.secretsDir, `${LOCAL_CLI_CREDENTIAL_SECRET}.bin`);
  const missing = () =>
    new LiveServiceCredentialError({
      reason:
        `The running SpecWithCode (pid ${state.pid}) has not published a credential for this CLI at ${file}. ` +
        "It is older than this CLI, or could not write the file: restart SpecWithCode (update it if it is older), then try again.",
    });
  const token = yield* fs.readFileString(file).pipe(
    Effect.map((text) => text.trim()),
    Effect.mapError((cause) =>
      cause.reason._tag === "NotFound"
        ? missing()
        : new LiveServiceCredentialError({
            reason: `Could not read the CLI credential at ${file}: ${cause.message}`,
          }),
    ),
  );
  if (token.length === 0) return yield* missing();
  return token;
});

/**
 * Where to send the CLI credential: the service's loopback address. A service
 * bound to every interface is called on 127.0.0.1; one bound to a loopback
 * address, there. A service bound to any other address or name is refused:
 * the credential never goes over plain HTTP to whatever that name resolves to.
 */
export const localServiceOrigin = (
  state: Pick<PersistedServerRuntimeState, "pid" | "host" | "port">,
) => {
  const host = state.host;
  if (host === undefined || host.length === 0 || isWildcardHost(host)) {
    return Effect.succeed(`http://127.0.0.1:${state.port}`);
  }
  if (isLoopbackHost(host)) return Effect.succeed(`http://${formatHostForUrl(host)}:${state.port}`);
  return Effect.fail(
    new LiveServiceUnsupportedError({
      reason:
        `SpecWithCode (pid ${state.pid}) listens on ${host}, not on a loopback address. ` +
        "This CLI sends its credential only to 127.0.0.1 or ::1; do this in the SpecWithCode app instead.",
    }),
  );
};

/**
 * Confirms the server answering at `origin` is this home's service, by the
 * environment id the home recorded, before any credential is sent to it. A
 * port another process took after the service stopped answers with no
 * descriptor or another id.
 */
export const confirmLiveServiceIdentity = Effect.fn("cli.liveService.confirmIdentity")(function* (
  config: Pick<LiveServiceConfig, "environmentIdPath">,
  origin: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const expected = yield* fs.readFileString(config.environmentIdPath).pipe(
    Effect.map((text) => text.trim()),
    Effect.orElseSucceed(() => ""),
  );
  if (expected.length === 0) {
    return yield* new LiveServiceCredentialError({
      reason: `This home has no environment id at ${config.environmentIdPath}, so the running service cannot be confirmed; the CLI credential was not sent.`,
    });
  }
  const probed = yield* probeEnvironmentDescriptor(origin).pipe(
    Effect.provide(FetchHttpClient.layer),
  );
  if (probed._tag !== "descriptor") {
    return yield* new LiveServiceRequestError({
      reason: `Nothing at ${origin} answers as SpecWithCode (${probed._tag}); the CLI credential was not sent.`,
    });
  }
  if (probed.descriptor.environmentId !== expected) {
    return yield* new LiveServiceCredentialError({
      reason: `The server at ${origin} is environment ${probed.descriptor.environmentId}, not this home's ${expected}; the CLI credential was not sent.`,
    });
  }
});

/**
 * The origin to call the running service on and the token to call it with,
 * after `localServiceOrigin` and `confirmLiveServiceIdentity` passed.
 */
export const liveServiceEndpoint = Effect.fn("cli.liveService.endpoint")(function* (
  config: LiveServiceConfig,
  state: Pick<PersistedServerRuntimeState, "pid" | "host" | "port">,
) {
  const origin = yield* localServiceOrigin(state);
  yield* confirmLiveServiceIdentity(config, origin);
  const token = yield* readLocalCliToken(config, state);
  return { origin, token } as const;
});

/**
 * The running service and the token to call it with, or none when no service
 * runs. `state.origin` is the confirmed loopback origin (`liveServiceEndpoint`).
 */
export const liveServiceAccess = Effect.fn("cli.liveService.access")(function* (
  config: LiveServiceConfig,
) {
  const state = yield* runningService(config);
  if (Option.isNone(state)) return Option.none<LiveServiceAccess>();
  const { origin, token } = yield* liveServiceEndpoint(config, state.value);
  return Option.some<LiveServiceAccess>({ state: { ...state.value, origin }, token });
});

export interface LiveServiceAccess {
  readonly state: PersistedServerRuntimeState;
  readonly token: string;
}

export const bearerHeaders = (token: string) => ({ authorization: `Bearer ${token}` });

export const liveServiceClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });

const describeFailure = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null) {
    const record = cause as { readonly message?: unknown; readonly _tag?: unknown };
    const message = typeof record.message === "string" ? record.message.trim() : "";
    if (message.length > 0) return message;
    if (typeof record._tag === "string") return record._tag;
  }
  return String(cause);
};

const looksUnauthorized = (cause: unknown): boolean => {
  const text = `${(cause as { readonly _tag?: unknown } | null)?._tag ?? ""} ${describeFailure(cause)}`;
  return /unauthori[sz]ed|auth.*invalid|invalid.*credential|revoked|401/i.test(text);
};

/** A failed call to the running service, in words, with what to try. */
export const liveServiceRequestError = (origin: string, what: string) => (cause: unknown) =>
  new LiveServiceRequestError({
    reason:
      `The running SpecWithCode at ${origin} did not ${what}: ${describeFailure(cause)}` +
      (looksUnauthorized(cause)
        ? " The CLI credential it published was refused; restart SpecWithCode to publish a new one."
        : ""),
    cause,
  });

/** A WebSocket ticket for the local CLI session, from `/api/auth/websocket-ticket`. */
export const liveWebSocketTicket = (access: LiveServiceAccess) =>
  Effect.gen(function* () {
    const client = yield* liveServiceClient(access.state.origin);
    const issued = yield* client.auth.webSocketTicket({ headers: bearerHeaders(access.token) });
    return issued.ticket;
  }).pipe(
    Effect.mapError(liveServiceRequestError(access.state.origin, "issue a WebSocket ticket")),
  );

const isGrantScope = Schema.is(AuthGrantScope);

/** The scopes a pairing through the running service may carry, or a refusal naming the rest. */
export const pairingGrantScopes = (scopes: ReadonlyArray<AuthEnvironmentScope>) => {
  const refused = scopes.filter((scope) => !isGrantScope(scope));
  return refused.length === 0
    ? Effect.succeed(scopes.filter(isGrantScope))
    : Effect.fail(
        new LiveServiceUnsupportedError({
          reason: `The running SpecWithCode does not grant ${refused.join(", ")} through a pairing token.`,
        }),
      );
};
