import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthAdministrativeScopes, EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkGrants from "../fleet/WorkGrants.ts";

const layer = WorkGrants.layer.pipe(
  Layer.provideMerge(
    EnvironmentAuth.layer.pipe(
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "principal-1050-" })),
  Layer.provideMerge(NodeServices.layer),
);
const request = (token: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://localhost/api/auth/pairing-token", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );

it.effect("legacy trusted provenance keeps local desktop, CLI, relay and cloud working", () =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore.SessionStore;
    const sql = yield* SqlClient.SqlClient;
    for (const subject of [
      "desktop-bootstrap",
      "administrative-bootstrap",
      "local-cli-owner",
      "managed-relay-bootstrap",
      "cloud-connect",
    ]) {
      const issued = yield* sessions.issue({ subject, method: "bearer-access-token" });
      yield* sql`UPDATE auth_sessions SET principal = NULL WHERE session_id = ${issued.sessionId}`;
      expect((yield* sessions.verify(issued.token)).subject).toBe(subject);
      const ticket = yield* sessions.issueWebSocketToken(issued.sessionId);
      expect((yield* sessions.verifyWebSocketToken(ticket.token)).subject).toBe(subject);
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("bearer revocation lookup uses the principal primary-key index", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const plan =
      yield* sql`EXPLAIN QUERY PLAN SELECT COALESCE(revoked_at, (SELECT revoked_at FROM auth_principal_revocations WHERE principal = auth_sessions.principal)) FROM auth_sessions WHERE session_id = 'synthetic'`;
    expect(JSON.stringify(plan)).toContain("sqlite_autoindex_auth_principal_revocations_1");
    expect(JSON.stringify(plan)).not.toContain("SCAN auth_principal_revocations");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "R-E-03 ambiguous legacy CLI-subject invitations require approval regardless of label",
  () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const sql = yield* SqlClient.SqlClient;
      for (const label of ["Fleet management (fleet invite)", "renamed device", undefined]) {
        const old = yield* sessions.issue({
          subject: "cli-issued-session",
          method: "bearer-access-token",
          client: { deviceType: "bot", ...(label ? { label } : {}) },
        });
        const ticket = yield* sessions.issueWebSocketToken(old.sessionId);
        yield* sql`UPDATE auth_sessions SET principal = NULL WHERE session_id = ${old.sessionId}`;
        expect((yield* Effect.flip(sessions.verify(old.token)))._tag).toBe(
          "DeviceReapprovalRequiredError",
        );
        expect((yield* Effect.flip(sessions.verifyWebSocketToken(ticket.token)))._tag).toBe(
          "DeviceReapprovalRequiredError",
        );
        expect(
          (yield* sql`SELECT session_id FROM auth_sessions WHERE session_id = ${old.sessionId}`)
            .length,
        ).toBe(1);
      }
      // Reissuing a genuine CLI-owner credential locally needs no remote sign-in.
      const local = yield* (yield* EnvironmentAuth.EnvironmentAuth).issueSession();
      expect((yield* sessions.verify(local.token)).subject).toBe("local-cli-owner");
    }).pipe(Effect.provide(layer)),
);

it.effect("R-E-01 consumed pairing grant cannot persist a session after revoke and restore", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const pairing = yield* PairingGrantStore.PairingGrantStore;
    const repository = yield* AuthSessions.AuthSessionRepository;
    const sql = yield* SqlClient.SqlClient;
    const principal = {
      kind: "coordinator" as const,
      environmentId: EnvironmentId.make("consumed-before-revoke"),
    };
    const code = yield* auth.issuePairingCredential({
      coordinatorEnvironmentId: principal.environmentId,
    });
    const consumed = yield* pairing.consume(code.credential);
    expect(consumed.principalGeneration).toBe(0);
    yield* auth.setPrincipalRevoked(principal, true);
    yield* auth.setPrincipalRevoked(principal, false);
    const late = yield* Effect.exit(
      sessions.issue({
        principal,
        principalGeneration: consumed.principalGeneration,
        subject: "one-time-token",
        method: "bearer-access-token",
      }),
    );
    expect(late._tag).toBe("Failure");
    expect(yield* repository.currentPrincipalGeneration(principal)).toBe(1);
    expect(
      yield* sql`SELECT session_id FROM auth_sessions WHERE principal = ${JSON.stringify(principal)}`,
    ).toEqual([]);
    const fresh = yield* auth.issuePairingCredential({
      coordinatorEnvironmentId: principal.environmentId,
    });
    const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
      fresh.credential,
      undefined,
      { deviceType: "desktop" },
    );
    expect((yield* sessions.verify(token.access_token)).principalGeneration).toBe(1);
  }).pipe(Effect.provide(layer)),
);
