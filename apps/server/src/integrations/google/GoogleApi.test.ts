import * as NodeHttp from "node:http";
import { afterAll, assert, beforeAll, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { FetchHttpClient } from "effect/http";

import * as GoogleApi from "./GoogleApi.ts";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}
const seen: Seen[] = [];
let server: NodeHttp.Server;
let base = "";

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization,
        body,
      });
      const json = (status: number, value: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      const form = new URLSearchParams(body);
      if (request.url === "/token" && form.get("grant_type") === "authorization_code") {
        return json(200, {
          access_token: "access-a",
          expires_in: 3599,
          refresh_token: "refresh-a",
          scope: "openid https://www.googleapis.com/auth/gmail.readonly",
          id_token: "h.e30.s",
        });
      }
      if (request.url === "/token") return json(400, { error: "invalid_grant" });
      if (request.url?.startsWith("/gmail/v1/users/me/messages?")) {
        return json(200, { messages: [{ id: "m1" }] });
      }
      if (request.url?.startsWith("/drive/v3/files/big")) {
        response.writeHead(200, { "content-type": "text/plain", "content-length": "5000" });
        return response.end("x".repeat(5000));
      }
      return json(403, {
        error: { status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] },
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}`;
  // Read when the layer is built, so it must be set before any test provides it.
  process.env.STUDIO_GOOGLE_API_URL = base;
});

afterAll(async () => {
  delete process.env.STUDIO_GOOGLE_API_URL;
  await new Promise<void>((done) => server.close(() => done()));
});

const withApi = <A, E>(use: (api: GoogleApi.GoogleApi["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const api = yield* GoogleApi.GoogleApi;
    assert.isTrue(api.endpoints.token.startsWith(base), "never reaches the real Google");
    return yield* use(api);
  }).pipe(Effect.provide(GoogleApi.layer.pipe(Layer.provide(FetchHttpClient.layer))));

it.effect("exchanges a code with a form body and reads with a bearer token", () =>
  withApi((api) =>
    Effect.gen(function* () {
      const tokens = yield* api.exchangeCode({
        clientId: "client-1",
        clientSecret: Redacted.make("secret-1"),
        code: "code-1",
        codeVerifier: "verifier-1",
        redirectUri: "http://127.0.0.1:8319/api/google/oauth/callback",
      });
      assert.strictEqual(Redacted.value(tokens.accessToken), "access-a");
      assert.strictEqual(Redacted.value(tokens.refreshToken!), "refresh-a");
      const exchange = new URLSearchParams(seen.at(-1)!.body);
      assert.deepStrictEqual(Object.fromEntries(exchange), {
        grant_type: "authorization_code",
        code: "code-1",
        code_verifier: "verifier-1",
        redirect_uri: "http://127.0.0.1:8319/api/google/oauth/callback",
        client_id: "client-1",
        client_secret: "secret-1",
      });

      const list = yield* api.getJson({
        operation: "Gmail search",
        url: `${api.endpoints.gmail}/users/me/messages`,
        query: { q: "is:unread newer_than:1d", metadataHeaders: ["From", "Subject"] },
        accessToken: tokens.accessToken,
      });
      assert.deepStrictEqual(list, { messages: [{ id: "m1" }] });
      const get = seen.at(-1)!;
      assert.strictEqual(get.authorization, "Bearer access-a");
      assert.strictEqual(
        get.url,
        "/gmail/v1/users/me/messages?q=is%3Aunread+newer_than%3A1d&metadataHeaders=From&metadataHeaders=Subject",
      );
    }),
  ),
);

it.effect("reports Google's error code and refuses oversized files without echoing requests", () =>
  withApi((api) =>
    Effect.gen(function* () {
      const refresh = yield* Effect.exit(
        api.refresh({
          clientId: "client-1",
          clientSecret: Redacted.make("secret-1"),
          refreshToken: Redacted.make("refresh-a"),
        }),
      );
      assert.isTrue(Exit.isFailure(refresh));
      const refreshError = Exit.isFailure(refresh) ? String(refresh.cause) : "";
      assert.include(refreshError, "invalid_grant");
      assert.notInclude(refreshError, "secret-1");
      assert.notInclude(refreshError, "refresh-a");

      const denied = yield* Effect.flip(
        api.getJson({
          operation: "Drive search",
          url: `${api.endpoints.drive}/files`,
          accessToken: Redacted.make("access-a"),
        }),
      );
      assert.deepStrictEqual([denied.status, denied.reason], [403, "insufficientPermissions"]);

      const tooBig = yield* Effect.flip(
        api.getText({
          operation: "Drive download",
          url: `${api.endpoints.drive}/files/big`,
          accessToken: Redacted.make("access-a"),
          maxBytes: 1000,
        }),
      );
      assert.deepStrictEqual([tooBig.status, tooBig.reason], [413, "fileTooLarge"]);
    }),
  ),
);
