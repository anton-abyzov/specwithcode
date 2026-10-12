/**
 * GoogleApi - the OAuth token calls and authenticated GETs the Google account
 * makes.
 *
 * Request URLs carry search terms and tokens travel in headers and bodies, so
 * the HTTP client's tracing is turned off and failures keep only the
 * operation, the status and Google's short error code, never the request or
 * the client's own error. `STUDIO_GOOGLE_API_URL` points tests at a fake
 * server holding every Google endpoint.
 *
 * @module GoogleApi
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import { googleEndpoints, type GoogleEndpoints } from "./googleAccountLogic.ts";

export class GoogleApiError extends Schema.TaggedError<GoogleApiError>()("GoogleApiError", {
  operation: Schema.String,
  /** HTTP status when Google answered; absent for network failures and timeouts. */
  status: Schema.optional(Schema.Number),
  /** Google's short error code, such as `invalid_grant` or `insufficientPermissions`. */
  reason: Schema.optional(Schema.String),
}) {
  override get message(): string {
    if (this.status === undefined) return `Google could not be reached (${this.operation}).`;
    return `Google ${this.operation} failed with ${this.status}${this.reason ? ` (${this.reason})` : ""}.`;
  }
}

export interface GoogleTokens {
  readonly accessToken: Redacted.Redacted<string>;
  readonly expiresInSeconds: number;
  /** Only returned on the first exchange (and when Google rotates it). */
  readonly refreshToken: Redacted.Redacted<string> | null;
  readonly scope: string | undefined;
  readonly idToken: string | undefined;
}

export interface GoogleClientCredentials {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted<string>;
}

export class GoogleApi extends Context.Service<
  GoogleApi,
  {
    readonly endpoints: GoogleEndpoints;
    readonly exchangeCode: (
      input: GoogleClientCredentials & {
        readonly code: string;
        readonly codeVerifier: string;
        readonly redirectUri: string;
      },
    ) => Effect.Effect<GoogleTokens, GoogleApiError>;
    readonly refresh: (
      input: GoogleClientCredentials & { readonly refreshToken: Redacted.Redacted<string> },
    ) => Effect.Effect<GoogleTokens, GoogleApiError>;
    readonly revoke: (token: Redacted.Redacted<string>) => Effect.Effect<void, GoogleApiError>;
    /** GET a JSON resource. */
    readonly getJson: (input: {
      readonly operation: string;
      readonly url: string;
      readonly query?: Record<string, string | ReadonlyArray<string> | undefined>;
      readonly accessToken: Redacted.Redacted<string>;
    }) => Effect.Effect<unknown, GoogleApiError>;
    /** GET a body as text, refusing anything larger than `maxBytes`. */
    readonly getText: (input: {
      readonly operation: string;
      readonly url: string;
      readonly query?: Record<string, string | undefined>;
      readonly accessToken: Redacted.Redacted<string>;
      readonly maxBytes: number;
    }) => Effect.Effect<string, GoogleApiError>;
  }
>()("studio/integrations/GoogleApi") {}

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  scope: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
});
const decodeToken = Schema.decodeUnknownEffect(TokenResponse);

/** Google answers OAuth errors as `{error}` and API errors as `{error: {status, errors: [{reason}]}}`. */
function errorReason(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error === "string") return error.slice(0, 60);
  if (error && typeof error === "object") {
    const nested = error as { status?: unknown; errors?: ReadonlyArray<{ reason?: unknown }> };
    const reason = nested.errors?.[0]?.reason;
    if (typeof reason === "string") return reason.slice(0, 60);
    if (typeof nested.status === "string") return nested.status.slice(0, 60);
  }
  return undefined;
}

const toParams = (
  query: Record<string, string | ReadonlyArray<string> | undefined> | undefined,
) => {
  const params: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (typeof value === "string") params.push([key, value]);
    else for (const item of value) params.push([key, item]);
  }
  return params;
};

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const endpoints = googleEndpoints(process.env.STUDIO_GOOGLE_API_URL);

  const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    client.execute(request).pipe(
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.timeout("30 seconds"),
      Effect.mapError(() => new GoogleApiError({ operation })),
    );

  const failWith = (operation: string, status: number, body: unknown) => {
    const reason = errorReason(body);
    return Effect.fail(
      new GoogleApiError({ operation, status, ...(reason === undefined ? {} : { reason }) }),
    );
  };

  const tokenCall = (operation: string, form: Record<string, string>) =>
    Effect.gen(function* () {
      const response = yield* send(
        operation,
        HttpClientRequest.post(endpoints.token).pipe(HttpClientRequest.bodyUrlParams(form)),
      );
      const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
      if (response.status >= 400) return yield* failWith(operation, response.status, body);
      const token = yield* decodeToken(body).pipe(
        Effect.mapError(() => new GoogleApiError({ operation, status: response.status })),
      );
      return {
        accessToken: Redacted.make(token.access_token),
        expiresInSeconds: token.expires_in ?? 3600,
        refreshToken: token.refresh_token === undefined ? null : Redacted.make(token.refresh_token),
        scope: token.scope,
        idToken: token.id_token,
      } satisfies GoogleTokens;
    });

  const authorizedGet = (
    operation: string,
    url: string,
    query: Record<string, string | ReadonlyArray<string> | undefined> | undefined,
    accessToken: Redacted.Redacted<string>,
  ) =>
    send(
      operation,
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setUrlParams(toParams(query)),
        HttpClientRequest.bearerToken(accessToken),
      ),
    );

  return GoogleApi.of({
    endpoints,
    exchangeCode: (input) =>
      tokenCall("sign-in", {
        grant_type: "authorization_code",
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
        client_id: input.clientId,
        client_secret: Redacted.value(input.clientSecret),
      }),
    refresh: (input) =>
      tokenCall("token refresh", {
        grant_type: "refresh_token",
        refresh_token: Redacted.value(input.refreshToken),
        client_id: input.clientId,
        client_secret: Redacted.value(input.clientSecret),
      }),
    revoke: (token) =>
      send(
        "revoke",
        HttpClientRequest.post(endpoints.revoke).pipe(
          HttpClientRequest.bodyUrlParams({ token: Redacted.value(token) }),
        ),
      ).pipe(
        Effect.flatMap((response) =>
          // 400 means the token was already invalid, which is the goal.
          response.status > 400
            ? Effect.fail(new GoogleApiError({ operation: "revoke", status: response.status }))
            : Effect.void,
        ),
      ),
    getJson: ({ operation, url, query, accessToken }) =>
      Effect.gen(function* () {
        const response = yield* authorizedGet(operation, url, query, accessToken);
        const body = yield* response.json.pipe(
          Effect.mapError(() => new GoogleApiError({ operation, status: response.status })),
        );
        if (response.status >= 400) return yield* failWith(operation, response.status, body);
        return body as unknown;
      }),
    getText: ({ operation, url, query, accessToken, maxBytes }) =>
      Effect.gen(function* () {
        const response = yield* authorizedGet(operation, url, query, accessToken);
        if (response.status >= 400) {
          const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
          return yield* failWith(operation, response.status, body);
        }
        const declared = Number(response.headers["content-length"] ?? "0");
        if (Number.isFinite(declared) && declared > maxBytes) {
          return yield* new GoogleApiError({ operation, status: 413, reason: "fileTooLarge" });
        }
        const bytes = yield* response.arrayBuffer.pipe(
          Effect.mapError(() => new GoogleApiError({ operation, status: response.status })),
        );
        if (bytes.byteLength > maxBytes) {
          return yield* new GoogleApiError({ operation, status: 413, reason: "fileTooLarge" });
        }
        return new TextDecoder().decode(bytes);
      }),
  });
});

export const layer = Layer.effect(GoogleApi, make);
