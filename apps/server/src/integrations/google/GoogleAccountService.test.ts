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
  let apiFailure: GoogleApi.GoogleApiError | null = null;
  let scope = SCOPE_GMAIL_CALENDAR;
  let unauthorizedOnce = false;
  let listed: ReadonlyArray<unknown> = [];
  const posts: Array<{ operation: string; url: string; body: unknown }> = [];
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
            scope,
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
            scope,
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
        if (apiFailure) return yield* apiFailure;
        if (url.endsWith("/users/me/messages")) return { messages: [{ id: "m1" }] };
        if (url.endsWith("/users/me/messages/m1")) {
          return {
            id: "m1",
            threadId: "t1",
            snippet: "Hi",
            labelIds: ["UNREAD"],
            payload: {
              headers: [
                { name: "Subject", value: "Dinner" },
                { name: "From", value: "Ann <ann@example.com>" },
                { name: "Message-ID", value: "<m1@example.com>" },
              ],
            },
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
    postJson: ({ operation, url, body, accessToken }) =>
      Effect.gen(function* () {
        calls.push({ operation, url, query: undefined, token: Redacted.value(accessToken) });
        posts.push({ operation, url, body });
        if (apiFailure) return yield* apiFailure;
        return { id: "d1", message: { id: "dm1", threadId: "t1" } };
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
          list: () => Effect.succeed(listed),
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
    posts,
    revoked,
    tokenClients,
    failRefresh: (error: GoogleApi.GoogleApiError | null) => {
      refreshFailure = error;
    },
    failApi: (error: GoogleApi.GoogleApiError | null) => {
      apiFailure = error;
    },
    grantAllScopes: () => {
      scope = `${SCOPE_GMAIL_CALENDAR} https://www.googleapis.com/auth/drive.readonly`;
    },
    grantDrafts: () => {
      scope = `${SCOPE_GMAIL_CALENDAR} https://www.googleapis.com/auth/gmail.compose`;
    },
    unauthorizeNextCall: () => {
      unauthorizedOnce = true;
    },
    listProjects: (rows: ReadonlyArray<unknown>) => {
      listed = rows;
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
        "not the one SpecWithCode started",
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
        "not the one SpecWithCode started",
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

const connectForHealth = (google: GoogleAccountService.GoogleAccountService["Service"]) =>
  Effect.gen(function* () {
    const state = new URL(
      (yield* google.startSignIn({ services: ["gmail", "calendar", "drive"] })).signIn!
        .authorizationUrl,
    ).searchParams.get("state");
    yield* google.completeSignIn({ callbackUrl: `?code=good-code&state=${state}` });
  });

it.effect(
  "explains setup, project grants and consent without network requests or ungranted identity",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const google = yield* GoogleAccountService.GoogleAccountService;
        assert.strictEqual(
          (yield* google.projectAccess(PROJECT, { checkConnection: true })).connectionState,
          "not_configured",
        );
        yield* google.configureClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
        assert.strictEqual(
          (yield* google.projectAccess(PROJECT, { checkConnection: true })).connectionState,
          "disconnected",
        );
        yield* connectForHealth(google);
        const ungranted = yield* google.projectAccess(OTHER_PROJECT, { checkConnection: true });
        assert.strictEqual(ungranted.connectionState, "project_access_required");
        assert.strictEqual(ungranted.email, null);
        assert.deepStrictEqual(ungranted.services, []);
        assert.isTrue(ungranted.serviceChecks.every((check) => check.status === "not_authorized"));
        yield* google.setProjectAccess({ projectId: PROJECT, services: ["drive"] });
        const missingScope = yield* google.projectAccess(PROJECT, { checkConnection: true });
        assert.strictEqual(missingScope.connectionState, "scope_required");
        assert.strictEqual(missingScope.email, null);
        assert.deepStrictEqual(
          missingScope.serviceChecks.find((check) => check.service === "drive"),
          {
            service: "drive",
            status: "scope_missing",
            message: "Reconnect Google and approve this service.",
          },
        );
        assert.strictEqual(
          missingScope.serviceChecks.find((check) => check.service === "gmail")?.status,
          "not_authorized",
        );
        assert.strictEqual(missingScope.checkedAt, null);
        assert.deepStrictEqual(harness.calls, []);
        assert.strictEqual(harness.tokenClients.length, 1);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect(
  "checks all three granted APIs using content-free requests and discards their bodies",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness(STUDIO_CLIENT);
      harness.grantAllScopes();
      yield* Effect.gen(function* () {
        const google = yield* GoogleAccountService.GoogleAccountService;
        yield* connectForHealth(google);
        yield* google.setProjectAccess({
          projectId: PROJECT,
          services: ["gmail", "calendar", "drive"],
        });
        const saved = yield* google.projectAccess(PROJECT);
        assert.strictEqual(saved.connectionState, "configured");
        assert.strictEqual(saved.checkedAt, null);
        assert.deepStrictEqual(harness.calls, []);
        const checked = yield* google.projectAccess(PROJECT, { checkConnection: true });
        assert.strictEqual(checked.connectionState, "verified");
        assert.isNotNull(checked.checkedAt);
        assert.deepStrictEqual(
          checked.serviceChecks.map((check) => check.status),
          ["ok", "ok", "ok", "not_authorized"],
        );
        assert.deepStrictEqual(
          harness.calls.map(({ url, query }) => ({ url, query })),
          [
            {
              url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
              query: { fields: "historyId" },
            },
            {
              url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
              query: { maxResults: "1", fields: "kind" },
            },
            {
              url: "https://www.googleapis.com/drive/v3/files",
              query: { pageSize: "1", fields: "kind" },
            },
          ],
        );
        const serialized = JSON.stringify(checked);
        for (const forbidden of [
          "Standup",
          "Europe/Berlin",
          "e1",
          "access-1",
          "refresh-1",
          "Dinner",
          "GOCSPX",
        ])
          assert.notInclude(serialized, forbidden);
        assert.strictEqual(harness.tokenClients.length, 1);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("probes only this project's allowed and consented services", () =>
  Effect.gen(function* () {
    const harness = makeHarness(STUDIO_CLIENT);
    yield* Effect.gen(function* () {
      const google = yield* GoogleAccountService.GoogleAccountService;
      yield* connectForHealth(google);
      yield* google.setProjectAccess({ projectId: PROJECT, services: ["calendar", "drive"] });
      yield* google.setProjectAccess({ projectId: OTHER_PROJECT, services: ["gmail"] });
      const result = yield* google.projectAccess(PROJECT, { checkConnection: true });
      assert.deepStrictEqual(result.services, ["calendar"]);
      assert.deepStrictEqual(
        result.serviceChecks.map((check) => check.status),
        ["not_authorized", "ok", "scope_missing", "not_authorized"],
      );
      assert.strictEqual(harness.calls.length, 1);
      assert.include(harness.calls[0]!.url, "/calendars/primary/events");
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect.each([
  { status: 403, reason: "accessNotConfigured", expected: "api_disabled" },
  { status: 403, reason: "insufficientPermissions", expected: "access_denied" },
  { status: 401, expected: "authentication_failed" },
  { expected: "unreachable" },
  { status: 500, expected: "error" },
])("reports live Google health failure $expected without claiming connectivity", (failure) =>
  Effect.gen(function* () {
    const harness = makeHarness(STUDIO_CLIENT);
    yield* Effect.gen(function* () {
      const google = yield* GoogleAccountService.GoogleAccountService;
      yield* connectForHealth(google);
      yield* google.setProjectAccess({ projectId: PROJECT, services: ["gmail"] });
      harness.failApi(
        new GoogleApi.GoogleApiError({ operation: "Gmail connection check", ...failure }),
      );
      const result = yield* google.projectAccess(PROJECT, { checkConnection: true });
      assert.strictEqual(result.connectionState, "error");
      assert.strictEqual(result.serviceChecks[0]!.status, failure.expected);
      assert.isNotNull(result.checkedAt);
      assert.notInclude(JSON.stringify(result), "access-1");
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "a revoked refresh token produces disconnected diagnostics and hides account identity",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness(STUDIO_CLIENT);
      yield* Effect.gen(function* () {
        const google = yield* GoogleAccountService.GoogleAccountService;
        yield* connectForHealth(google);
        yield* google.setProjectAccess({ projectId: PROJECT, services: ["gmail"] });
        harness.unauthorizeNextCall();
        harness.failRefresh(
          new GoogleApi.GoogleApiError({
            operation: "token refresh",
            status: 400,
            reason: "invalid_grant",
          }),
        );
        const result = yield* google.projectAccess(PROJECT, { checkConnection: true });
        assert.strictEqual(result.connectionState, "disconnected");
        assert.strictEqual(result.email, null);
        assert.deepStrictEqual(result.services, []);
        assert.strictEqual(result.serviceChecks[0]!.status, "authentication_failed");
        assert.notInclude(JSON.stringify(result), "me@example.com");
        assert.isFalse(harness.secrets.has("google-refresh-token"));
      }).pipe(Effect.provide(harness.layer));
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

it.effect("saves a threaded reply draft only with Gmail drafts on, and never sends", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* Effect.gen(function* () {
      const google = yield* GoogleAccountService.GoogleAccountService;
      yield* google.configureClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      harness.grantDrafts();
      const signIn = yield* google.startSignIn({ services: ["gmail", "gmailDrafts"] });
      const authorize = new URL(signIn.signIn!.authorizationUrl);
      assert.include(authorize.searchParams.get("scope")!, "auth/gmail.compose");
      yield* google.completeSignIn({
        callbackUrl: `?code=good-code&state=${authorize.searchParams.get("state")}`,
      });
      assert.deepStrictEqual((yield* google.status).services, ["gmail", "calendar", "gmailDrafts"]);

      // Reading mail is not enough: drafts need their own switch.
      yield* google.setProjectAccess({ projectId: PROJECT, services: ["gmail"] });
      assert.include(
        failureDetail(
          yield* Effect.exit(google.gmailCreateDraft(PROJECT, { messageId: "m1", body: "Yes" })),
        ),
        "Gmail drafts is not turned on for this project",
      );
      assert.strictEqual(harness.posts.length, 0);

      yield* google.setProjectAccess({ projectId: PROJECT, services: ["gmail", "gmailDrafts"] });
      assert.include(
        failureDetail(
          yield* Effect.exit(google.gmailCreateDraft(PROJECT, { messageId: "m1", body: "  " })),
        ),
        "needs a reply text",
      );
      const draft = yield* google.gmailCreateDraft(PROJECT, {
        messageId: "m1",
        body: "Thursday works.\nAnton",
      });
      assert.deepStrictEqual(draft, {
        draftId: "d1",
        threadId: "t1",
        to: "Ann <ann@example.com>",
        subject: "Re: Dinner",
        link: "https://mail.google.com/mail/#drafts?compose=dm1",
        sent: false,
      });
      assert.strictEqual(harness.posts.length, 1);
      const post = harness.posts[0]!;
      assert.strictEqual(post.url, "https://gmail.googleapis.com/gmail/v1/users/me/drafts");
      const message = (post.body as { message: { raw: string; threadId: string } }).message;
      assert.strictEqual(message.threadId, "t1");
      const raw = Buffer.from(message.raw, "base64url").toString("utf8");
      assert.include(raw, "To: Ann <ann@example.com>\r\n");
      assert.include(raw, "In-Reply-To: <m1@example.com>\r\n");
      assert.include(raw, "References: <m1@example.com>\r\n");
      // Nothing anywhere asks Gmail to send.
      assert.isTrue(harness.calls.every((call) => !call.url.includes("/send")));
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

it.effect("connects with SpecWithCode's own client when the person saved none", () =>
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

it.effect("drops a saved sign-in after a restart with a different SpecWithCode client", () =>
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

it.effect("a new account starts with only live personal projects switched on", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    harness.listProjects([
      { projectId: PROJECT, deletedAt: null, workspaceSettings: { kind: "personal" } },
      { projectId: OTHER_PROJECT, deletedAt: null, workspaceSettings: { kind: "code" } },
      {
        projectId: "project-archived",
        deletedAt: null,
        workspaceSettings: { kind: "personal", archived: true },
      },
    ]);
    yield* Effect.gen(function* () {
      const google = yield* GoogleAccountService.GoogleAccountService;
      yield* google.configureClient({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      yield* connectForHealth(google);
      assert.deepStrictEqual((yield* google.status).projects, [
        { projectId: PROJECT, services: ["gmail", "calendar"] },
      ]);
      yield* google.setProjectAccess({ projectId: PROJECT, services: [] });
      yield* connectForHealth(google);
      // Reconnecting the same account keeps what the person chose.
      assert.deepStrictEqual((yield* google.status).projects, []);
    }).pipe(Effect.provide(harness.layer));
  }),
);
