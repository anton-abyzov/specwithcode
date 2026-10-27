/**
 * The credential the CLI on this machine uses to ask the running service to
 * do something, so that no CLI command has to open the live database.
 *
 * Before October 2026 a CLI command that needed the running service (`pair`,
 * `service prepare-update`, `project`, `connect`, `fleet invite`) opened
 * `userdata/statev2.sqlite` read-write to insert a session row for itself,
 * then called the service with it. A read-write connection that closes while
 * it believes it is the last user checkpoints and deletes `-wal` and `-shm`;
 * once the service had lost its POSIX locks, that is how the live files were
 * deleted under it (M4, 2026-10-26; docs/operations/live-database.md).
 *
 * Instead the service, which owns the database, issues a bearer session for
 * the local CLI each time it starts and writes the token to the secrets
 * folder (`<userdata>/secrets/local-cli-credential.bin`, mode 0600 in a 0700
 * folder, beside the signing key every session is signed with, so reading it
 * needs no access the CLI did not already have). The CLI reads that file and
 * calls the service over HTTP or its WebSocket.
 *
 * The session lives in the service's memory only (SessionStore `inMemory`):
 * - a start writes no `auth_sessions` row, so the update helper's
 *   post-restart auth proof (scripts/studio-fleet/auth_heartbeat.py) sees the
 *   same rows, and a file that cannot be written leaves no orphan session;
 * - "Sign out other devices" cannot revoke it, and it is not listed in
 *   Settings > Connections, so no other session can pass itself off as it;
 * - a token copied from the file stops working when that service exits, so
 *   the file a crash leaves behind is worth nothing.
 * The file is removed again when the service stops.
 *
 * @module LocalCliCredential
 */
import { AuthAdministrativeScopes } from "@specweave-studio/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

/** Secret name; the file is `<secretsDir>/local-cli-credential.bin`. */
export const LOCAL_CLI_CREDENTIAL_SECRET = "local-cli-credential";
export const LOCAL_CLI_CREDENTIAL_LABEL = "SpecWithCode CLI on this machine";
/** Its own subject, never one a pairing or `auth session issue` gives out. */
export const LOCAL_CLI_CREDENTIAL_SUBJECT = "local-cli-credential";
/** Longer than a service runs between restarts; the session ends with the process anyway. */
export const LOCAL_CLI_CREDENTIAL_TTL = Duration.days(365);

const encoder = new TextEncoder();

/**
 * Issues this process's local CLI session and writes its token to the secret
 * store, replacing the previous process's token. Returns the session id.
 */
export const publishLocalCliCredential = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const issued = yield* environmentAuth.issueSession({
    subject: LOCAL_CLI_CREDENTIAL_SUBJECT,
    scopes: AuthAdministrativeScopes,
    label: LOCAL_CLI_CREDENTIAL_LABEL,
    ttl: LOCAL_CLI_CREDENTIAL_TTL,
    inMemory: true,
  });
  yield* secrets.set(LOCAL_CLI_CREDENTIAL_SECRET, encoder.encode(issued.token));
  return issued.sessionId;
}).pipe(Effect.withSpan("LocalCliCredential.publish"));

/**
 * Publishes the local CLI credential while the service starts and removes the
 * file when it stops. A failure is logged, never fatal: the service works
 * without it, and only CLI commands that need the running service then say so.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* Effect.acquireRelease(
      publishLocalCliCredential.pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Could not publish the local CLI credential; CLI commands that need the running service will fail until it restarts.",
          ).pipe(Effect.annotateLogs({ cause }), Effect.as(false)),
        ),
      ),
      (published) =>
        published ? secrets.remove(LOCAL_CLI_CREDENTIAL_SECRET).pipe(Effect.ignore) : Effect.void,
    );
  }),
);
