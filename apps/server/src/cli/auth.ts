import {
  AuthAdministrativeScopes,
  AuthSessionId,
  EnvironmentId,
  AuthStandardClientScopes,
} from "@specweave-studio/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, type HttpClient } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "../cliAuthFormat.ts";
import * as ServerConfig from "../config.ts";
import { authScopesFlag } from "./authScopes.ts";
import {
  bearerHeaders,
  type LiveServiceAccess,
  liveServiceAccess,
  livePairingTtl,
  liveServiceClient,
  liveServiceRefusal,
  liveServiceRequestError,
  pairingGrantScopes,
} from "./liveService.ts";
import {
  authLocationFlags,
  type CliAuthLocationFlags,
  DurationFromString,
  resolveCliAuthConfig,
} from "./config.ts";

/**
 * Runs a command against this home's auth store. While a service runs from the
 * home, `live` runs instead: it calls that service over HTTP with the
 * credential the service published for this machine's CLI, and the live
 * database is not opened (cli/liveService.ts). Otherwise `offline` opens the
 * store directly, which itself refuses if a service has started meanwhile.
 */
const runWithEnvironmentAuth = <A, E, A2, E2>(
  flags: CliAuthLocationFlags,
  offline: (environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
  live: (access: LiveServiceAccess) => Effect.Effect<A2, E2, HttpClient.HttpClient>,
  options?: {
    readonly quietLogs?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const access = yield* liveServiceAccess(config);
    if (Option.isSome(access)) {
      return yield* live(access.value).pipe(Effect.provide(FetchHttpClient.layer));
    }
    const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* offline(environmentAuth);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(EnvironmentAuth.layerRuntime).pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });

/** One call to the running service's auth API with the local CLI credential. */
const callLive = <A, E>(
  access: LiveServiceAccess,
  what: string,
  call: (
    client: Effect.Success<ReturnType<typeof liveServiceClient>>,
    headers: ReturnType<typeof bearerHeaders>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const client = yield* liveServiceClient(access.state.origin);
    return yield* call(client, bearerHeaders(access.token));
  }).pipe(Effect.mapError(liveServiceRequestError(access.state.origin, what)));

const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const tokenOnlyFlag = Flag.Boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthStandardClientScopes),
  ttl: ttlFlag,
  label: labelFlag,
  coordinator: Flag.String("coordinator").pipe(
    Flag.withDescription(
      "Explicitly approve this coordinator environment ID for fleet work and renewal.",
    ),
    Flag.optional,
  ),
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a new client pairing token."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const issued = yield* environmentAuth.createPairingLink({
            scopes: flags.scopes,
            subject: "one-time-token",
            ...(Option.isSome(flags.coordinator)
              ? {
                  principal: {
                    kind: "coordinator" as const,
                    environmentId: EnvironmentId.make(flags.coordinator.value),
                  },
                }
              : {}),
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          });
          const output = formatIssuedPairingCredential(issued, {
            json: flags.json,
            ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value } : {}),
          });
          yield* Console.log(output);
        }),
      (access) =>
        Effect.gen(function* () {
          const ttl = yield* livePairingTtl(flags.ttl);
          const scopes = yield* pairingGrantScopes(flags.scopes);
          const issued = yield* callLive(access, "issue a pairing token", (client, headers) =>
            client.auth.pairingCredential({
              headers,
              payload: {
                scopes,
                ...ttl,
                ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
                ...(Option.isSome(flags.coordinator)
                  ? { coordinatorEnvironmentId: EnvironmentId.make(flags.coordinator.value) }
                  : {}),
              },
            }),
          );
          yield* Console.log(
            formatIssuedPairingCredential(
              { ...issued, scopes: flags.scopes },
              {
                json: flags.json,
                ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value } : {}),
              },
            ),
          );
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active client pairing tokens without revealing their secrets."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const pairingLinks = yield* environmentAuth.listPairingLinks({
            excludeSubjects: [EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT],
          });
          yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
        }),
      (access) =>
        Effect.gen(function* () {
          const pairingLinks = yield* callLive(access, "list pairing tokens", (client, headers) =>
            client.auth.pairingLinks({ headers }),
          );
          yield* Console.log(
            formatPairingCredentialList(
              pairingLinks.filter(
                (link) =>
                  link.subject !== EnvironmentAuth.INTERNAL_ADMINISTRATIVE_BOOTSTRAP_SUBJECT,
              ),
              { json: flags.json },
            ),
          );
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
}).pipe(
  Command.withDescription("Revoke an active client pairing token."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const revoked = yield* environmentAuth.revokePairingLink(flags.id);
          yield* Console.log(
            revoked
              ? `Revoked pairing credential ${flags.id}.\n`
              : `No active pairing credential found for ${flags.id}.\n`,
          );
        }),
      (access) =>
        Effect.gen(function* () {
          const { revoked } = yield* callLive(
            access,
            "revoke the pairing token",
            (client, headers) =>
              client.auth.revokePairingLink({ headers, payload: { id: flags.id } }),
          );
          yield* Console.log(
            revoked
              ? `Revoked pairing credential ${flags.id}.\n`
              : `No active pairing credential found for ${flags.id}.\n`,
          );
        }),
    ),
  ),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  scopes: authScopesFlag(AuthAdministrativeScopes),
  ttl: ttlFlag,
  label: labelFlag,
  subject: subjectFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a scoped bearer access token for headless or remote clients."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const issued = yield* environmentAuth.issueSession({
            scopes: flags.scopes,
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
            ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
          });
          yield* Console.log(
            formatIssuedSession(issued, {
              json: flags.json,
              tokenOnly: flags.tokenOnly,
            }),
          );
        }),
      (access) =>
        Effect.fail(
          liveServiceRefusal(
            access.state,
            "Issuing a bearer access token",
            "Pair the device instead (`pair`, or Settings > Connections), or stop SpecWithCode and run this again.",
          ),
        ),
      {
        quietLogs: flags.json || flags.tokenOnly,
      },
    ),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active sessions without revealing bearer tokens."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const sessions = yield* environmentAuth.listSessions();
          yield* Console.log(formatSessionList(sessions, { json: flags.json }));
        }),
      (access) =>
        Effect.gen(function* () {
          const sessions = yield* callLive(access, "list sessions", (client, headers) =>
            client.auth.clients({ headers }),
          );
          yield* Console.log(formatSessionList(sessions, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.String("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription("Revoke an active session."),
  Command.withHandler((flags) =>
    runWithEnvironmentAuth(
      flags,
      (environmentAuth) =>
        Effect.gen(function* () {
          const revoked = yield* environmentAuth.revokeSession(flags.sessionId);
          yield* Console.log(
            revoked
              ? `Revoked session ${flags.sessionId}.\n`
              : `No active session found for ${flags.sessionId}.\n`,
          );
        }),
      (access) =>
        Effect.gen(function* () {
          const { revoked } = yield* callLive(access, "revoke the session", (client, headers) =>
            client.auth.revokeClient({ headers, payload: { sessionId: flags.sessionId } }),
          );
          yield* Console.log(
            revoked
              ? `Revoked session ${flags.sessionId}.\n`
              : `No active session found for ${flags.sessionId}.\n`,
          );
        }),
    ),
  ),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage the local auth control plane for headless deployments."),
  Command.withSubcommands([pairingCommand, sessionCommand]),
);
