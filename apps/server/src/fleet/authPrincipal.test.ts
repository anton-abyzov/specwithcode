import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthAdministrativeScopes, EnvironmentId } from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as WorkGrants from "./WorkGrants.ts";

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

it.effect("1050 revokes principal-derived management even with an unrelated label", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const grants = yield* WorkGrants.WorkGrants;
    const coordinator = EnvironmentId.make("revoked-peer");
    const other = EnvironmentId.make("unaffected-peer");
    const pair = (id: EnvironmentId) =>
      auth.issuePairingCredential({
        coordinatorEnvironmentId: id,
        label: "A display name",
        scopes: AuthAdministrativeScopes,
      });
    const connect = (code: string) =>
      auth.exchangeBootstrapCredentialForAccessToken(code, undefined, { deviceType: "desktop" });
    const management = yield* connect((yield* pair(coordinator)).credential);
    const unaffected = yield* connect((yield* pair(other)).credential);
    const pending = yield* pair(coordinator);
    const sessionStore = yield* SessionStore.SessionStore;
    const ticket = yield* sessionStore.issueWebSocketToken(
      (yield* sessionStore.verify(management.access_token)).sessionId,
    );
    yield* grants.forCoordinator(coordinator);
    yield* grants.revoke(coordinator);
    expect(
      (yield* Effect.exit(auth.authenticateHttpRequest(request(management.access_token))))._tag,
    ).toBe("Failure");
    expect(
      (yield* auth.authenticateHttpRequest(request(unaffected.access_token))).principal,
    ).toEqual({ kind: "coordinator", environmentId: other });
    expect((yield* Effect.exit(connect(pending.credential)))._tag).toBe("Failure");
    expect(
      (yield* Effect.exit(
        sessionStore.issue({
          subject: "one-time-token",
          method: "bearer-access-token",
          principal: { kind: "coordinator", environmentId: coordinator },
        }),
      ))._tag,
    ).toBe("Failure");
    expect((yield* Effect.exit(sessionStore.verifyWebSocketToken(ticket.token)))._tag).toBe(
      "Failure",
    );
    yield* grants.restore(coordinator);
    expect((yield* Effect.exit(sessionStore.verifyWebSocketToken(ticket.token)))._tag).toBe(
      "Failure",
    );
    const recovered = yield* connect((yield* pair(coordinator)).credential);
    expect(
      (yield* auth.authenticateHttpRequest(request(recovered.access_token))).principal,
    ).toEqual({ kind: "coordinator", environmentId: coordinator });
    expect(
      (yield* Effect.exit(auth.authenticateHttpRequest(request(management.access_token))))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(layer)),
);

it.effect("1050 legacy label-only sessions fail closed and reapproval restores access", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const sql = yield* SqlClient.SqlClient;
    const old = yield* sessions.issue({
      subject: "one-time-token",
      method: "bearer-access-token",
      client: { deviceType: "desktop", label: "Known machine" },
    });
    const ticket = yield* sessions.issueWebSocketToken(old.sessionId);
    yield* sql`UPDATE auth_sessions SET principal = NULL WHERE session_id = ${old.sessionId}`;
    const error = yield* Effect.flip(auth.authenticateHttpRequest(request(old.token)));
    if (!EnvironmentAuth.isServerAuthCredentialError(error)) return yield* error;
    expect(EnvironmentAuth.serverAuthCredentialReason(error)).toBe("device_reapproval_required");
    expect(error.message).toContain("Approve this device again");
    expect((yield* Effect.flip(sessions.verifyWebSocketToken(ticket.token)))._tag).toBe(
      "DeviceReapprovalRequiredError",
    );
    expect(yield* auth.getSessionState(request(old.token))).toMatchObject({
      authenticated: false,
      reapprovalRequired: true,
      message: "Approve this device again in SpecWithCode.",
    });
    const reapproved = yield* auth.issuePairingCredential({ label: "Known machine" });
    const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
      reapproved.credential,
      undefined,
      { deviceType: "desktop" },
    );
    expect((yield* auth.authenticateHttpRequest(request(token.access_token))).principal?.kind).toBe(
      "device",
    );
    expect(
      (yield* sql`SELECT session_id FROM auth_sessions WHERE session_id = ${old.sessionId}`).length,
    ).toBe(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("1050 grant lookup uses the principal and refuses a label-only impersonation", () =>
  Effect.gen(function* () {
    const grants = yield* WorkGrants.WorkGrants;
    const peer = EnvironmentId.make("approved-peer");
    expect(
      (yield* Effect.flip(
        grants.forClient({ label: "SpecWithCode workers · victim", access: "auto" }),
      )).message,
    ).toContain("Approve this device again");
    expect(
      (yield* grants.forClient({
        principal: { kind: "coordinator", environmentId: peer },
        label: "Unrelated display name",
        access: "auto",
      }))?.coordinatorEnvironmentId,
    ).toBe(peer);
  }).pipe(Effect.provide(layer)),
);
