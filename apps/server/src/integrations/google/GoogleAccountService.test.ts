import { ProjectId } from "@specweave-studio/contracts";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as GoogleApi from "./GoogleApi.ts";
import * as GoogleAccountService from "./GoogleAccountService.ts";
import { googleEndpoints } from "./googleAccountLogic.ts";
import { BuiltInGoogleClient, type GoogleOAuthClient } from "./googleBuiltInClient.ts";

const CLIENT_ID = "123456-abcdefgh.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-test-client-secret";
const STUDIO_CLIENT: GoogleOAuthClient = {
  clientId: "987654-studioclient.apps.googleusercontent.com",
  clientSecret: Redacted.make("GOCSPX-studio-shipped-secret"),
};
const PROJECT = ProjectId.make("project-personal");
const OTHER_PROJECT = ProjectId.make("project-code");
const idToken = (email: string) =>
  `h.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.s`;
const SCOPE_GMAIL_CALENDAR =
  "openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly";

interface Call {
  readonly operation: string;
  readonly url: string;
  readonly query: unknown;
  readonly token: string;
}

const makeHarness = (
  builtIn: GoogleOAuthClient | null = null,
  /** Pass a previous harness's secrets to model a restart. */
  secrets = new Map<string, Uint8Array>(),
) => {
  const calls: Call[] = [];
  /** Which client id each token call used. */
  const tokenClients: string[] = [];
  const revoked: string[] = [];
  let accessCounter = 0;
  let refreshFailure: GoogleApi.GoogleApiError | null = null;
  let unauthorizedOnce = false;
  const nextAccess = () => Redacted.make(`access-${++accessCounter}`);

  const api = GoogleApi.GoogleApi.of({
    endpoints: googleEndpoints(undefined),
    exchangeCode: (input) =>
      (tokenClients.push(input.clientId), input.code === "good-code") &&
      input.codeVerifier.length > 20
        ? Effect.succeed({
            accessToken: nextAccess(),
            expiresInSeconds: 3600,
            refreshToken: Redacted.make("refresh-1"),
            scope: SCOPE_GMAIL_CALENDAR,
            idToken: idToken("me@example.com"),
          })
        : Effect.fail(
            new GoogleApi.GoogleApiError({
              operation: "sign-in",
              status: 400,
              reason: "invalid_grant",
            }),
          ),
    refresh: (input) =>
      (tokenClients.push(input.clientId), refreshFailure)
        ? Effect.fail(refreshFailure)
        : Effect.succeed({
            accessToken: nextAccess(),
            expiresInSeconds: 3600,
            refreshToken: null,
            scope: SCOPE_GMAIL_CALENDAR,
            idToken: undefined,
          }),
    revoke: (token) => Effect.sync(() => void revoked.push(Redacted.value(token))),
    getJson: ({ operation, url, query, accessToken }) =>
      Effect.gen(function* () {
        calls.push({ operation, url, query, token: Redacted.value(accessToken) });
        if (unauthorizedOnce) {
          unauthorizedOnce = false;
          return yield* new GoogleApi.GoogleApiError({ operation, status: 401 });
        }
        if (url.endsWith("/users/me/messages")) return { messages: [{ id: "m1" }] };
        if (url.endsWith("/users/me/messages/m1")) {
          return {
            id: "m1",
            snippet: "Hi",
            labelIds: ["UNREAD"],
            payload: { headers: [{ name: "Subject", value: "Dinner" }] },
          };
        }
        if (url.includes("/calendars/primary/events")) {
          return {
            timeZone: "Europe/Berlin",
            items: [
              { id: "e1", summary: "Standup", start: { dateTime: "2026-10-11T09:00:00Z" } },
              { id: "e2", status: "cancelled", summary: "Gone" },
            ],
          };
        }
        return {};
      }),
    getText: () => Effect.succeed(""),
  });

  const layer = GoogleAccountService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(GoogleApi.GoogleApi)(api),
        Layer.succeed(ServerSecretStore.ServerSecretStore)(
          ServerSecretStore.ServerSecretStore.of({
            get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
            set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
            create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
            getOrCreateRandom: () => Effect.die("unused"),
            remove: (name) => Effect.sync(() => void secrets.delete(name)),
          }),
        ),
        Layer.succeed(ProjectStore.ProjectStoreV2)({
          get: (projectId: ProjectId) =>
            Effect.succeed(
              projectId === PROJECT || projectId === OTHER_PROJECT
                ? Option.some({ projectId, title: "Errands", deletedAt: null })
                : Option.none(),
            ),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Layer.succeed(ServerConfig.ServerConfig)({ port: 8319 } as never),
        Layer.succeed(BuiltInGoogleClient, builtIn),
        Layer.succeed(Crypto.Crypto)({
          randomBytes: (size: number) =>
            Effect.succeed(Uint8Array.from({ length: size }, (_, index) => index)),
          digest: () => Effect.succeed(new Uint8Array(32).fill(7)),
        } as never),
      ),
    ),
  );
  return {
    layer,
    secrets,
    calls,
    revoked,
    tokenClients,
    failRefresh: (error: GoogleApi.GoogleApiError | null) => {
      refreshFailure = error;
    },
    unauthorizeNextCall: () => {
      unauthorizedOnce = true;
    },
  };
};

const failureDetail = (exit: Exit.Exit<unknown, { readonly detail: string }>) =>
  Exit.isFailure(exit) ? (exit.cause.toString() ?? "") : "succeeded";

it.effect("signs in once with the state it issued and keeps secrets off the status", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const google = yield* GoogleAccountService.GoogleAccountService;
      assert.isFalse((yield* google.status).clientConfigured);
      assert.include(
        failureDetail(yield* Effect.exit(google.startSignIn({ services: ["gmail"] }))),
        "Save an OAuth client",
      );

      yield* google.configureClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      const started = yield* google.startSignIn({ services: ["gmail", "calendar", "drive"] });
      assert.isNotNull(started.signIn);
      const authorization = new URL(started.signIn!.authorizationUrl);
      assert.strictEqual(
        started.signIn!.redirectUri,
        "http://127.0.0.1:8319/api/google/oauth/callback",
      );
      assert.strictEqual(authorization.searchParams.get("client_id"), CLIENT_ID);
      const state = authorization.searchParams.get("state")!;

      assert.include(
        failureDetail(
          yield* Effect.exit(
            google.completeSignIn({ callbackUrl: `?code=good-code&state=forged` }),
          ),
        ),
        "not the one Studio started",
      );
      const callback = `http://127.0.0.1:8319/api/google/oauth/callback?code=good-code&state=${state}`;
      const page = yield* google.callbackPage(callback.slice(callback.indexOf("?")));
      assert.include(page, "Google account connected");
      assert.include(page, "Gmail, Google Calendar for me@example.com");

      // Google granted Gmail and Calendar only; Drive was unticked on the consent screen.
      const status = yield* google.status;
      assert.deepStrictEqual(
        { connected: status.connected, email: status.email, services: status.services },
        { connected: true, email: "me@example.com", services: ["gmail", "calendar"] },
      );
      const serialized = JSON.stringify(status);
      assert.notInclude(serialized, CLIENT_SECRET);
      assert.notInclude(serialized, "refresh-1");

      // The state is single use.
      assert.include(
        failureDetail(yield* Effect.exit(google.completeSignIn({ callbackUrl: callback }))),
        "not the one Studio started",
      );
    }).pipe(Effect.provide(harness.layer));
    assert.strictEqual(
      new TextDecoder().decode(harness.secrets.get("google-refresh-token")),
      "refresh-1",
    );
    assert.notInclude(
      new TextDecoder().decode(harness.secrets.get("google-account-state")),
      "refresh-1",
    );
  }),
);

it.effect("lets agents read only what their project was given", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const google = yield* GoogleAccountService.GoogleAccountService;
      yield* google.configureClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      const state = new URL(
        (yield* google.startSignIn({ services: ["gmail", "calendar"] })).signIn!.authorizationUrl,
      ).searchParams.get("state");
      yield* google.completeSignIn({ callbackUrl: `?code=good-code&state=${state}` });

      assert.include(
        failureDetail(yield* Effect.exit(google.gmailSearch(PROJECT, { query: "is:unread" }))),
        "Gmail is not turned on for this project",
      );
      yield* google.setProjectAccess({ projectId: PROJECT, services: ["gmail", "drive"] });
      assert.deepStrictEqual((yield* google.projectAccess(PROJECT)).services, ["gmail"]);
      assert.deepStrictEqual((yield* google.projectAccess(OTHER_PROJECT)).services, []);
      assert.strictEqual((yield* google.projectAccess(OTHER_PROJECT)).email, null);
      assert.include(
        failureDetail(yield* Effect.exit(google.driveSearch(PROJECT, {}))),
        "Google Drive is not turned on",
      );

      const found = (yield* google.gmailSearch(PROJECT, {
        query: "is:unread",
        maxResults: 99,
      })) as {
        messages: ReadonlyArray<{ subject: string; unread: boolean }>;
      };
      assert.deepStrictEqual(
        found.messages.map((m) => [m.subject, m.unread]),
        [["Dinner", true]],
      );
      assert.deepStrictEqual(harness.calls[0]!.query, { q: "is:unread", maxResults: "25" });
      assert.strictEqual(harness.calls[0]!.token, "access-1");

      // An expired access token is refreshed once and the call repeated.
      harness.unauthorizeNextCall();
      yield* google.setProjectAccess({ projectId: PROJECT, services: ["gmail", "calendar"] });
      const events = (yield* google.calendarEvents(PROJECT, {
        timeMin: "2026-10-11T00:00:00Z",
      })) as { events: ReadonlyArray<{ title: string }>; timeMax: string };
      assert.deepStrictEqual(
        events.events.map((e) => e.title),
        ["Standup"],
      );
      assert.strictEqual(events.timeMax, "2026-10-18T00:00:00.000Z");
      assert.deepStrictEqual(
        harness.calls.slice(-2).map((c) => c.token),
        ["access-1", "access-2"],
      );
      assert.include(
        failureDetail(yield* Effect.exit(google.calendarEvents(PROJECT, { timeMin: "tomorrow" }))),
        "is not a date and time",
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("forgets the sign-in when Google revokes it, and on disconnect", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const google = yield* GoogleAccountService.GoogleAccountService;
      const signIn = Effect.gen(function* () {
        const state = new URL(
          (yield* google.startSignIn({ services: ["gmail"] })).signIn!.authorizationUrl,
        ).searchParams.get("state");
        yield* google.completeSignIn({ callbackUrl: `?code=good-code&state=${state}` });
      });
      yield* google.configureClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      yield* signIn;
      yield* google.setProjectAccess({ projectId: PROJECT, services: ["gmail"] });

      harness.unauthorizeNextCall();
      harness.failRefresh(
        new GoogleApi.GoogleApiError({
          operation: "token refresh",
          status: 400,
          reason: "invalid_grant",
        }),
      );
      assert.include(
        failureDetail(yield* Effect.exit(google.gmailSearch(PROJECT, { query: "x" }))),
        "sign in again",
      );
      const afterRevoke = yield* google.status;
      assert.isFalse(afterRevoke.connected);
      assert.include(afterRevoke.lastError ?? "", "Sign in again");

      harness.failRefresh(null);
      yield* signIn;
      assert.isTrue((yield* google.status).connected);
      const disconnected = yield* google.disconnect;
      assert.isFalse(disconnected.connected);
      assert.deepStrictEqual(harness.revoked, ["refresh-1"]);
      // Project switches survive a disconnect; they apply again after the next sign-in.
      assert.deepStrictEqual(disconnected.projects, [{ projectId: PROJECT, services: ["gmail"] }]);

      const removed = yield* google.remove;
      assert.isFalse(removed.clientConfigured);
    }).pipe(Effect.provide(harness.layer));
    assert.strictEqual(harness.secrets.size, 0);
  }),
);

it.effect("connects with Studio's own client when the person saved none", () =>
  Effect.gen(function* () {
    const harness = makeHarness(STUDIO_CLIENT);
    yield* Effect.gen(function* () {
      const google = yield* GoogleAccountService.GoogleAccountService;
      const initial = yield* google.status;
      assert.deepStrictEqual(
        {
          configured: initial.clientConfigured,
          source: initial.clientSource,
          clientId: initial.clientId,
        },
        { configured: true, source: "studio", clientId: null },
      );

      const started = yield* google.startSignIn({ services: ["gmail", "calendar"] });
      const authorization = new URL(started.signIn!.authorizationUrl);
      assert.strictEqual(authorization.searchParams.get("client_id"), STUDIO_CLIENT.clientId);
      assert.strictEqual(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.notInclude(authorization.searchParams.get("scope") ?? "", "gmail.modify");
      const state = authorization.searchParams.get("state");
      const connected = yield* google.completeSignIn({
        callbackUrl: `?code=good-code&state=${state}`,
      });
      assert.isTrue(connected.connected);
      assert.notInclude(JSON.stringify(connected), "GOCSPX-studio-shipped-secret");
      assert.deepStrictEqual(harness.tokenClients, [STUDIO_CLIENT.clientId]);

      // Saving their own client replaces Studio's and revokes the sign-in made with it.
      const own = yield* google.configureClient({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
      });
      assert.deepStrictEqual(
        {
          source: own.clientSource,
          clientId: own.clientId,
          connected: own.connected,
          email: own.email,
        },
        { source: "own", clientId: CLIENT_ID, connected: false, email: null },
      );
      assert.deepStrictEqual(harness.revoked, ["refresh-1"]);

      // Remove forgets their client; Studio's is still there to connect with.
      const removed = yield* google.remove;
      assert.deepStrictEqual(
        { configured: removed.clientConfigured, source: removed.clientSource },
        { configured: true, source: "studio" },
      );
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("asks for a new sign-in when Google no longer accepts the client", () =>
  Effect.gen(function* () {
    const harness = makeHarness(STUDIO_CLIENT);
    yield* Effect.gen(function* () {
      const google = yield* GoogleAccountService.GoogleAccountService;
      const state = new URL(
        (yield* google.startSignIn({ services: ["gmail"] })).signIn!.authorizationUrl,
      ).searchParams.get("state");
      yield* google.completeSignIn({ callbackUrl: `?code=good-code&state=${state}` });
      yield* google.setProjectAccess({ projectId: PROJECT, services: ["gmail"] });

      harness.unauthorizeNextCall();
      harness.failRefresh(
        new GoogleApi.GoogleApiError({
          operation: "token refresh",
          status: 401,
          reason: "unauthorized_client",
        }),
      );
      assert.include(
        failureDetail(yield* Effect.exit(google.gmailSearch(PROJECT, { query: "x" }))),
        "sign in again",
      );
      assert.isFalse((yield* google.status).connected);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("drops a saved sign-in after a restart with a different Studio client", () =>
  Effect.gen(function* () {
    const first = makeHarness(STUDIO_CLIENT);
    yield* Effect.gen(function* () {
      const google = yield* GoogleAccountService.GoogleAccountService;
      const state = new URL(
        (yield* google.startSignIn({ services: ["gmail"] })).signIn!.authorizationUrl,
      ).searchParams.get("state");
      yield* google.completeSignIn({ callbackUrl: `?code=good-code&state=${state}` });
    }).pipe(Effect.provide(first.layer));

    // Same client after a restart: still connected.
    const same = makeHarness(STUDIO_CLIENT, first.secrets);
    const kept = yield* GoogleAccountService.GoogleAccountService.pipe(
      Effect.flatMap((google) => google.status),
      Effect.provide(same.layer),
    );
    assert.isTrue(kept.connected);

    // A build with another client cannot use that refresh token.
    const rotated = makeHarness(
      { ...STUDIO_CLIENT, clientId: "555555-rotatedclient.apps.googleusercontent.com" },
      first.secrets,
    );
    const dropped = yield* GoogleAccountService.GoogleAccountService.pipe(
      Effect.flatMap((google) => google.status),
      Effect.provide(rotated.layer),
    );
    assert.deepStrictEqual(
      { connected: dropped.connected, email: dropped.email },
      { connected: false, email: null },
    );
    assert.include(dropped.lastError ?? "", "Connect again");
    assert.isFalse(first.secrets.has("google-refresh-token"));
  }),
);
