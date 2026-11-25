import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(
    Layer.effect(
      ServerConfig.ServerConfig,
      Effect.map(ServerConfig.ServerConfig, (config) => ({
        ...config,
        desktopBootstrapToken: "desktop-bootstrap-token",
      })),
    ).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "studio-revoke-others-" })),
    ),
  ),
);

const requestMetadata = { deviceType: "desktop" as const, os: "macOS", browser: "Chrome" };

const bearer = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

it.layer(NodeServices.layer)("revoke other clients", (it) => {
  it.effect("also ends pairing codes nobody has used yet", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const owner = yield* auth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );
      const ownerSession = yield* auth.authenticateHttpRequest(bearer(owner.access_token));
      const leaked = yield* auth.issuePairingCredential();
      const leakedLink = yield* auth.createPairingLink({ label: "Phone" });

      yield* auth.revokeOtherClientSessions(ownerSession.sessionId);

      // A code minted before the revoke no longer signs anything in.
      const refused = yield* Effect.flip(
        auth.exchangeBootstrapCredentialForAccessToken(
          leaked.credential,
          undefined,
          requestMetadata,
        ),
      );
      expect(refused._tag).toBe("ServerAuthInvalidCredentialError");
      const refusedLink = yield* Effect.flip(
        auth.createBrowserSession(leakedLink.credential, requestMetadata),
      );
      expect(refusedLink._tag).toBe("ServerAuthInvalidCredentialError");
      expect(yield* auth.listPairingLinks()).toEqual([]);

      // The caller keeps its session; the desktop and a fresh code still sign in.
      yield* auth.authenticateHttpRequest(bearer(owner.access_token));
      yield* auth.exchangeBootstrapCredentialForAccessToken(
        "desktop-bootstrap-token",
        undefined,
        requestMetadata,
      );
      const fresh = yield* auth.issuePairingCredential();
      yield* auth.exchangeBootstrapCredentialForAccessToken(
        fresh.credential,
        undefined,
        requestMetadata,
      );
    }).pipe(Effect.provide(layerEnvironmentAuth)),
  );

  it.effect("refuses an MCP session whose sign-in began before the revoke", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const owner = yield* auth.issueSession();
      const startedAt = yield* auth.revocationEpoch;

      yield* auth.revokeOtherClientSessions(owner.sessionId);

      const refused = yield* Effect.flip(
        auth.issueMcpClientSession({
          label: "Claude Code",
          access: "auto",
          client: { deviceType: "bot" },
          revocationEpoch: startedAt,
        }),
      );
      expect(refused._tag).toBe("ServerAuthSessionTokenIssueError");
      yield* auth.issueMcpClientSession({
        label: "Claude Code",
        access: "auto",
        client: { deviceType: "bot" },
        revocationEpoch: yield* auth.revocationEpoch,
      });
    }).pipe(Effect.provide(layerEnvironmentAuth)),
  );
});
