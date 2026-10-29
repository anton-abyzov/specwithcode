import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
} from "@specweave-studio/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpRouter from "effect/http/HttpRouter";

import * as Auth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { GITHUB_CREDENTIAL_PATH, REPLACED_TOKEN_SECRET } from "./GitHubCredentialCopy.ts";
import { routeLayer } from "./gitHubCredentialRoute.ts";
import { tokenFingerprint } from "./gitHubCredentialState.ts";

const TOKEN = "gho_route_token_never_echoed";
const TOKENS: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  "Bearer fleet-management": AuthStandardClientScopes,
  "Bearer read-only": [AuthOrchestrationReadScope],
};
const BODY = { token: TOKEN, login: "octo", from: "M4" };
const HAND_SAVED = "ghp_handSavedTokenOnTheWorker123";

/** An in-memory secret store, so a set-aside token can be checked. */
const memorySecrets = () => {
  const values = new Map<string, Uint8Array>();
  const store = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => values.get(name) ?? new Uint8Array(bytes)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
  });
  return { values, store };
};

/** The real route behind a web handler, with test settings and a scope-per-token auth. */
const harness = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = memorySecrets();
  const routes = routeLayer.pipe(
    Layer.provideMerge(Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.store)),
    Layer.provideMerge(Layer.succeed(ServerSettings.ServerSettingsService, settings)),
    Layer.provideMerge(
      Layer.mock(Auth.EnvironmentAuth)({
        authenticateHttpRequest: (request) => {
          const scopes = TOKENS[request.headers.authorization ?? ""];
          return scopes
            ? Effect.succeed({
                sessionId: AuthSessionId.make("fleet-session"),
                subject: "fleet",
                method: "bearer-access-token" as const,
                scopes,
              })
            : Effect.fail(new Auth.ServerAuthMissingCredentialError({}));
        },
      }),
    ),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const post = (
    body: unknown,
    {
      token = "fleet-management",
      host = "m3.tailnet.ts.net",
      headers = {} as Record<string, string>,
    } = {},
  ) =>
    Effect.promise(async () => {
      const response = await handler(
        new Request(`https://${host}${GITHUB_CREDENTIAL_PATH}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            host,
            ...headers,
          },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, text: await response.text() };
    });
  const github = settings.getSettings.pipe(Effect.map((value) => value.github));
  return { post, github, settings: settings.getSettings, service: settings, secrets };
}).pipe(Effect.provide(ServerSettings.layerTest()));

describe("the GitHub sign-in copy route", () => {
  it.effect("stores the token as the saved token with a note, and never echoes it", () =>
    Effect.gen(function* () {
      const { post, github, settings } = yield* harness;
      const reply = yield* post(BODY);
      expect(reply.status).toBe(200);
      expect(reply.text).not.toContain(TOKEN);
      expect(JSON.parse(reply.text)).toEqual({ copiedAt: expect.any(String) });
      const stored = yield* github;
      expect(stored.tokens["github.com"]).toBe(TOKEN);
      expect(stored.copiedTokens["github.com"]).toMatchObject({
        from: "M4",
        login: "octo",
        fingerprint: tokenFingerprint(TOKEN),
      });
      // Clients see the note, never the token or its fingerprint.
      const forClient = JSON.stringify(
        ServerSettings.redactServerSettingsForClient(yield* settings).github,
      );
      expect(forClient).not.toContain(TOKEN);
      expect(forClient).not.toContain(tokenFingerprint(TOKEN));
      expect(forClient).toContain('"from":"M4"');
    }).pipe(Effect.scoped),
  );

  it.effect("never replaces a token saved by hand unless asked, then keeps it aside", () =>
    Effect.gen(function* () {
      const { post, github, service, secrets } = yield* harness;
      yield* service.updateSettings({ github: { tokens: { "github.com": HAND_SAVED } } });
      const refused = yield* post(BODY);
      expect(refused.status).toBe(409);
      expect((yield* github).tokens["github.com"]).toBe(HAND_SAVED);

      const replaced = yield* post({ ...BODY, replace: true });
      expect(replaced.status).toBe(200);
      const stored = yield* github;
      expect(stored.tokens["github.com"]).toBe(TOKEN);
      expect(stored.copiedTokens["github.com"]).toMatchObject({ replacedSaved: true });
      expect(new TextDecoder().decode(secrets.values.get(REPLACED_TOKEN_SECRET))).toBe(HAND_SAVED);

      // A second copy over the first keeps the set-aside token and its note.
      expect((yield* post(BODY)).status).toBe(200);
      expect((yield* github).copiedTokens["github.com"]).toMatchObject({ replacedSaved: true });
      expect(new TextDecoder().decode(secrets.values.get(REPLACED_TOKEN_SECRET))).toBe(HAND_SAVED);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses callers without settings write, and stores nothing", () =>
    Effect.gen(function* () {
      const { post, github } = yield* harness;
      const readOnly = yield* post(BODY, { token: "read-only" });
      const anonymous = yield* post(BODY, { token: "nope" });
      expect([readOnly.status, anonymous.status]).toEqual([403, 401]);
      expect(readOnly.text).not.toContain(TOKEN);
      expect((yield* github).tokens["github.com"]).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a token sent through a Connect address", () =>
    Effect.gen(function* () {
      const { post, github } = yield* harness;
      const reply = yield* post(BODY, { host: "prod-0123456789abcdef.spec-weave.com" });
      expect(reply.status).toBe(403);
      expect(JSON.parse(reply.text)).toEqual({ error: "tailnet_only" });
      expect((yield* github).tokens["github.com"]).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a token the Connect tunnel stamped, whatever its Host", () =>
    Effect.gen(function* () {
      const { post, github } = yield* harness;
      const reply = yield* post(BODY, { headers: { "cf-ray": "8f0000000000-MIA" } });
      expect(reply.status).toBe(403);
      expect(JSON.parse(reply.text)).toEqual({ error: "tailnet_only" });
      expect((yield* github).tokens["github.com"]).toBeUndefined();
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a malformed body without echoing it", () =>
    Effect.gen(function* () {
      const { post } = yield* harness;
      const reply = yield* post({ ...BODY, token: `${TOKEN}${"x".repeat(2000)}` });
      expect(reply.status).toBe(400);
      expect(reply.text).not.toContain(TOKEN);
    }).pipe(Effect.scoped),
  );
});
