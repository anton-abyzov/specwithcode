/**
 * GoogleAccountService - one Google account per Studio host, read-only.
 *
 * Sign-in uses the OAuth client shipped with Studio ("Desktop app" type) or,
 * when the person saved one, their own; theirs wins. Either way the person
 * signs in through Google's consent screen. Google redirects the browser back to this
 * host's loopback callback; when the browser runs elsewhere, the person pastes
 * the address it landed on. Sign-in uses PKCE and a single-use state that
 * expires after 15 minutes.
 *
 * The client secret and refresh token live in the host's secret store and are
 * never returned to clients. Agents read Gmail, Calendar and Drive only for
 * projects the person turned each service on for, through the project-bound
 * MCP tools in `mcp/toolkits/google`.
 *
 * @module GoogleAccountService
 */
import {
  GoogleAccountError,
  type GoogleAccountConfigureClientInput,
  type GoogleAccountSetProjectAccessInput,
  type GoogleAccountStartSignInInput,
  type GoogleAccountStatus,
  type GoogleService,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as GoogleApi from "./GoogleApi.ts";
import {
  googleHealthFailure,
  googleHealthRequest,
  projectGoogleStatus,
  type GoogleProjectStatus,
  type GoogleServiceCheck,
} from "./googleAccountHealth.ts";
import { BuiltInGoogleClient, type GoogleOAuthClient } from "./googleBuiltInClient.ts";
import {
  base64Url,
  buildAuthorizationUrl,
  callbackPage,
  describeCallbackError,
  DRIVE_DOWNLOAD_LIMIT_BYTES,
  DRIVE_EXPORT_TYPES,
  DRIVE_FILE_FIELDS,
  DRIVE_TEXT_LIMIT,
  driveQuery,
  buildGmailReplyDraft,
  emailFromIdToken,
  EMPTY_GOOGLE_ACCOUNT_STATE,
  GMAIL_DRAFT_BODY_LIMIT,
  gmailDraftLink,
  GOOGLE_CALLBACK_PATH,
  GoogleAccountState,
  isReadableDriveType,
  orderedServices,
  parseCallback,
  projectServices,
  readGmailMessage,
  servicesFromScope,
  SIGN_IN_TTL_MS,
  summarizeCalendarEvent,
  summarizeDriveFile,
  summarizeGmailMessage,
  truncateText,
  personalProjectAccess,
  withProjectAccess,
  type CalendarEvent,
  type DriveFile,
  type GmailMessage,
} from "./googleAccountLogic.ts";

export const GOOGLE_CLIENT_SECRET = "google-oauth-client";
export const GOOGLE_REFRESH_TOKEN_SECRET = "google-refresh-token";
export const GOOGLE_STATE_SECRET = "google-account-state";

const SERVICE_LABEL: Record<GoogleService, string> = {
  gmail: "Gmail",
  calendar: "Google Calendar",
  drive: "Google Drive",
  gmailDrafts: "Gmail drafts",
};

const StoredClient = Schema.Struct({ clientId: Schema.String, clientSecret: Schema.String });
const decodeClient = Schema.decodeUnknownExit(Schema.fromJsonString(StoredClient));
const encodeClient = Schema.encodeSync(Schema.fromJsonString(StoredClient));
const decodeState = Schema.decodeUnknownExit(Schema.fromJsonString(GoogleAccountState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(GoogleAccountState));
const isAccountError = Schema.is(GoogleAccountError);

export interface GmailSearchInput {
  readonly query: string;
  readonly maxResults?: number | undefined;
}
export interface CalendarEventsInput {
  readonly timeMin?: string | undefined;
  readonly timeMax?: string | undefined;
  readonly query?: string | undefined;
  readonly maxResults?: number | undefined;
}
export interface GmailCreateDraftInput {
  /** The message being answered, by the id studio_google_gmail_search returned. */
  readonly messageId: string;
  readonly body: string;
}
export interface DriveSearchInput {
  readonly text?: string | undefined;
  readonly modifiedAfter?: string | undefined;
  readonly maxResults?: number | undefined;
}

export class GoogleAccountService extends Context.Service<
  GoogleAccountService,
  {
    readonly status: Effect.Effect<GoogleAccountStatus>;
    readonly configureClient: (
      input: GoogleAccountConfigureClientInput,
    ) => Effect.Effect<GoogleAccountStatus, GoogleAccountError>;
    readonly startSignIn: (
      input: GoogleAccountStartSignInInput,
    ) => Effect.Effect<GoogleAccountStatus, GoogleAccountError>;
    /** Finishes sign-in from the address Google redirected to. */
    readonly completeSignIn: (input: {
      readonly callbackUrl: string;
    }) => Effect.Effect<GoogleAccountStatus, GoogleAccountError>;
    /** The loopback callback route: finishes sign-in and returns the page to show. */
    readonly callbackPage: (callbackUrl: string) => Effect.Effect<string>;
    readonly setProjectAccess: (
      input: GoogleAccountSetProjectAccessInput,
    ) => Effect.Effect<GoogleAccountStatus, GoogleAccountError>;
    /** Revokes and forgets the sign-in; keeps the OAuth client and project switches. */
    readonly disconnect: Effect.Effect<GoogleAccountStatus, GoogleAccountError>;
    /** Forgets everything, the OAuth client included. */
    readonly remove: Effect.Effect<GoogleAccountStatus, GoogleAccountError>;

    // Agent reads, each limited to what the project was given.
    readonly projectAccess: (
      projectId: ProjectId,
      input?: { readonly checkConnection?: boolean | undefined },
    ) => Effect.Effect<GoogleProjectStatus>;
    readonly gmailSearch: (
      projectId: ProjectId,
      input: GmailSearchInput,
    ) => Effect.Effect<unknown, GoogleAccountError>;
    readonly gmailRead: (
      projectId: ProjectId,
      messageId: string,
    ) => Effect.Effect<unknown, GoogleAccountError>;
    /**
     * Saves a reply draft in the person's Gmail, threaded under the message.
     * It is never sent: the person reviews and sends it from Gmail.
     */
    readonly gmailCreateDraft: (
      projectId: ProjectId,
      input: GmailCreateDraftInput,
    ) => Effect.Effect<
      {
        readonly draftId: string;
        readonly threadId: string | null;
        readonly to: string;
        readonly subject: string;
        readonly link: string | null;
        readonly sent: false;
      },
      GoogleAccountError
    >;
    readonly calendarEvents: (
      projectId: ProjectId,
      input: CalendarEventsInput,
    ) => Effect.Effect<unknown, GoogleAccountError>;
    readonly driveSearch: (
      projectId: ProjectId,
      input: DriveSearchInput,
    ) => Effect.Effect<unknown, GoogleAccountError>;
    readonly driveRead: (
      projectId: ProjectId,
      fileId: string,
    ) => Effect.Effect<unknown, GoogleAccountError>;
  }
>()("specweave-studio/integrations/google/GoogleAccountService") {}

interface PendingSignIn {
  readonly state: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly authorizationUrl: string;
  readonly expiresAt: number;
}

interface CachedAccessToken {
  readonly token: Redacted.Redacted<string>;
  readonly expiresAt: number;
}

const clamp = (value: number | undefined, fallback: number, max: number) =>
  value === undefined || !Number.isFinite(value)
    ? fallback
    : Math.max(1, Math.min(max, Math.trunc(value)));

const GOOGLE_ID = /^[A-Za-z0-9_-]{1,200}$/u;

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const api = yield* GoogleApi.GoogleApi;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const config = yield* ServerConfig.ServerConfig;
  const builtInClient = yield* BuiltInGoogleClient;
  const writes = yield* Semaphore.make(1);
  const tokenLock = yield* Semaphore.make(1);
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  const readSecret = (name: string) =>
    secrets.get(name).pipe(
      Effect.map(Option.map((bytes) => textDecoder.decode(bytes))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  const initialClient = yield* readSecret(GOOGLE_CLIENT_SECRET).pipe(
    Effect.map(
      Option.flatMap((json): Option.Option<GoogleOAuthClient> => {
        const decoded = decodeClient(json);
        return Exit.isSuccess(decoded)
          ? Option.some({
              clientId: decoded.value.clientId,
              clientSecret: Redacted.make(decoded.value.clientSecret),
            })
          : Option.none();
      }),
    ),
  );
  const initialState = yield* readSecret(GOOGLE_STATE_SECRET).pipe(
    Effect.map((stored) => {
      if (Option.isNone(stored)) return EMPTY_GOOGLE_ACCOUNT_STATE;
      const decoded = decodeState(stored.value);
      return Exit.isSuccess(decoded) ? decoded.value : EMPTY_GOOGLE_ACCOUNT_STATE;
    }),
  );
  const initialRefresh = yield* readSecret(GOOGLE_REFRESH_TOKEN_SECRET).pipe(
    Effect.map(Option.map((value) => Redacted.make(value))),
  );

  const clientRef = yield* Ref.make(initialClient);
  const stateRef = yield* Ref.make(initialState);
  const refreshRef = yield* Ref.make(initialRefresh);
  const accessRef = yield* Ref.make<CachedAccessToken | null>(null);
  const pendingRef = yield* Ref.make<PendingSignIn | null>(null);
  const lastErrorRef = yield* Ref.make<string | null>(null);

  const fail = (detail: string) => Effect.fail(new GoogleAccountError({ detail }));
  const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
  const redirectUri = `http://127.0.0.1:${config.port}${GOOGLE_CALLBACK_PATH}`;

  /** The person's own client wins over the one shipped with Studio. */
  const effectiveClient = (own: Option.Option<GoogleOAuthClient>) =>
    Option.isSome(own) ? own : Option.fromNullishOr(builtInClient);
  const currentClient = Ref.get(clientRef).pipe(Effect.map(effectiveClient));
  const NO_CLIENT = "Save an OAuth client before signing in.";

  const persistState = (state: GoogleAccountState) =>
    secrets.set(GOOGLE_STATE_SECRET, textEncoder.encode(encodeState(state))).pipe(
      Effect.andThen(Ref.set(stateRef, state)),
      Effect.mapError(
        () =>
          new GoogleAccountError({ detail: "SpecWithCode could not save the Google settings." }),
      ),
    );

  // A refresh token works only with the client that obtained it. When the client changed
  // since (a new Studio build or a removed own client), the saved sign-in cannot be used.
  const startupClient = effectiveClient(initialClient);
  if (
    Option.isSome(initialRefresh) &&
    initialState.clientId != null &&
    (Option.isNone(startupClient) || startupClient.value.clientId !== initialState.clientId)
  ) {
    yield* secrets.remove(GOOGLE_REFRESH_TOKEN_SECRET).pipe(Effect.ignore);
    yield* Ref.set(refreshRef, Option.none());
    yield* persistState({ ...initialState, email: null, clientId: null, services: [] }).pipe(
      Effect.ignore,
    );
    yield* Ref.set(lastErrorRef, "SpecWithCode's Google client changed. Connect again.");
  }

  const status: Effect.Effect<GoogleAccountStatus> = Effect.gen(function* () {
    const client = yield* Ref.get(clientRef);
    const state = yield* Ref.get(stateRef);
    const refresh = yield* Ref.get(refreshRef);
    const pending = yield* Ref.get(pendingRef);
    const now = yield* Clock.currentTimeMillis;
    const connected = Option.isSome(refresh);
    return {
      clientConfigured: Option.isSome(client) || builtInClient !== null,
      clientId: Option.isSome(client) ? client.value.clientId : null,
      clientSource: Option.isSome(client) ? "own" : builtInClient !== null ? "studio" : null,
      connected,
      email: connected ? state.email : null,
      services: connected ? [...state.services] : [],
      projects: state.projects.map((entry) => ({
        projectId: entry.projectId as ProjectId,
        services: [...entry.services],
      })),
      signIn:
        pending !== null && pending.expiresAt > now
          ? {
              authorizationUrl: pending.authorizationUrl,
              redirectUri: pending.redirectUri,
              expiresAt: isoAt(pending.expiresAt),
            }
          : null,
      lastError: yield* Ref.get(lastErrorRef),
    } satisfies GoogleAccountStatus;
  });

  /** Drops the sign-in locally; the caller decides whether to revoke it first. */
  const forgetSignIn = Effect.gen(function* () {
    yield* secrets.remove(GOOGLE_REFRESH_TOKEN_SECRET).pipe(Effect.ignore);
    yield* Ref.set(refreshRef, Option.none());
    yield* Ref.set(accessRef, null);
  });

  /**
   * Revokes the sign-in at Google (best effort), then forgets it here. Holds the token
   * lock so a refresh already in flight cannot bring the old sign-in back.
   */
  const revokeAndForget = Effect.gen(function* () {
    yield* tokenLock.withPermits(1)(
      Effect.gen(function* () {
        const refresh = yield* Ref.get(refreshRef);
        if (Option.isSome(refresh)) {
          // Best effort: the local copy is forgotten whether or not Google answers.
          yield* api.revoke(refresh.value).pipe(Effect.ignore);
        }
        yield* forgetSignIn;
      }),
    );
    const state = yield* Ref.get(stateRef);
    yield* persistState({ ...state, email: null, clientId: null, services: [] });
  });

  const configureClient = (input: GoogleAccountConfigureClientInput) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const previous = effectiveClient(yield* Ref.get(clientRef));
        yield* secrets
          .set(
            GOOGLE_CLIENT_SECRET,
            textEncoder.encode(
              encodeClient({ clientId: input.clientId, clientSecret: input.clientSecret }),
            ),
          )
          .pipe(
            Effect.mapError(
              () =>
                new GoogleAccountError({ detail: "SpecWithCode could not save the OAuth client." }),
            ),
          );
        yield* Ref.set(
          clientRef,
          Option.some({
            clientId: input.clientId,
            clientSecret: Redacted.make(input.clientSecret),
          }),
        );
        // A refresh token belongs to the client that obtained it.
        if (Option.isSome(previous) && previous.value.clientId !== input.clientId) {
          yield* revokeAndForget;
        }
        yield* Ref.set(pendingRef, null);
        yield* Ref.set(lastErrorRef, null);
        return yield* status;
      }),
    );

  const startSignIn = (input: GoogleAccountStartSignInInput) =>
    Effect.gen(function* () {
      const client = yield* currentClient;
      if (Option.isNone(client)) return yield* fail(NO_CLIENT);
      const services = orderedServices(input.services);
      if (services.length === 0) return yield* fail("Choose at least one Google service.");
      const random = yield* crypto
        .randomBytes(64)
        .pipe(
          Effect.mapError(
            () => new GoogleAccountError({ detail: "SpecWithCode could not start sign-in." }),
          ),
        );
      const codeVerifier = base64Url(random.slice(0, 32));
      const state = base64Url(random.slice(32));
      const challenge = yield* crypto
        .digest("SHA-256", textEncoder.encode(codeVerifier))
        .pipe(
          Effect.mapError(
            () => new GoogleAccountError({ detail: "SpecWithCode could not start sign-in." }),
          ),
        );
      const authorizationUrl = buildAuthorizationUrl({
        authorizeUrl: api.endpoints.authorize,
        clientId: client.value.clientId,
        redirectUri,
        services,
        state,
        codeChallenge: base64Url(challenge),
      });
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.set(pendingRef, {
        state,
        codeVerifier,
        redirectUri,
        authorizationUrl,
        expiresAt: now + SIGN_IN_TTL_MS,
      });
      yield* Ref.set(lastErrorRef, null);
      return yield* status;
    });

  const completeSignIn = (input: { readonly callbackUrl: string }) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const params = parseCallback(input.callbackUrl);
        if (params.type === "invalid") {
          return yield* fail(
            "That address has no Google sign-in code. Paste the whole address the browser landed on.",
          );
        }
        const pending = yield* Ref.get(pendingRef);
        const now = yield* Clock.currentTimeMillis;
        if (pending === null || pending.state !== params.state) {
          return yield* fail(
            "This sign-in is not the one SpecWithCode started. Start sign-in again.",
          );
        }
        if (pending.expiresAt <= now) {
          yield* Ref.set(pendingRef, null);
          return yield* fail("This sign-in expired. Start sign-in again.");
        }
        // Single use, whatever happens next.
        yield* Ref.set(pendingRef, null);
        if (params.type === "error") {
          const message = describeCallbackError(params.error);
          yield* Ref.set(lastErrorRef, message);
          return yield* fail(message);
        }
        const client = yield* currentClient;
        if (Option.isNone(client)) return yield* fail(NO_CLIENT);
        const tokens = yield* api
          .exchangeCode({
            clientId: client.value.clientId,
            clientSecret: client.value.clientSecret,
            code: params.code,
            codeVerifier: pending.codeVerifier,
            redirectUri: pending.redirectUri,
          })
          .pipe(
            Effect.tapError((error) => Ref.set(lastErrorRef, error.message)),
            Effect.mapError((error) => new GoogleAccountError({ detail: error.message })),
          );
        if (tokens.refreshToken === null) {
          return yield* fail(
            "Google did not return a refresh token. Remove SpecWithCode under Google Account > Security > Third-party access, then sign in again.",
          );
        }
        const refreshToken = tokens.refreshToken;
        const services = servicesFromScope(tokens.scope);
        const email = emailFromIdToken(tokens.idToken);
        const previous = yield* Ref.get(stateRef);
        // Switches were given for one person's data. A new or different account starts
        // with its personal projects only; reconnecting the same account keeps them.
        const newAccount =
          previous.email !== email && (previous.email !== null || previous.projects.length === 0);
        const projectAccess = newAccount
          ? personalProjectAccess(
              yield* projects.list().pipe(Effect.orElseSucceed(() => [])),
              services,
            )
          : previous.projects;
        // Under the token lock, so a refresh of the previous sign-in cannot overwrite this one.
        yield* tokenLock.withPermits(1)(
          Effect.gen(function* () {
            yield* secrets
              .set(GOOGLE_REFRESH_TOKEN_SECRET, textEncoder.encode(Redacted.value(refreshToken)))
              .pipe(
                Effect.mapError(
                  () =>
                    new GoogleAccountError({ detail: "SpecWithCode could not save the sign-in." }),
                ),
              );
            yield* Ref.set(refreshRef, Option.some(refreshToken));
            yield* Ref.set(accessRef, {
              token: tokens.accessToken,
              expiresAt: now + tokens.expiresInSeconds * 1000,
            });
          }),
        );
        yield* persistState({
          ...previous,
          email,
          clientId: client.value.clientId,
          services,
          projects: projectAccess,
        });
        yield* Ref.set(lastErrorRef, null);
        return yield* status;
      }),
    );

  const renderCallback = (callbackUrl: string) =>
    completeSignIn({ callbackUrl }).pipe(
      Effect.map((result) =>
        callbackPage({
          ok: true,
          message: `SpecWithCode can now read ${result.services.map((s) => SERVICE_LABEL[s]).join(", ") || "nothing yet"}${result.email ? ` for ${result.email}` : ""}. Personal projects can use it now; turn it on for other projects in SpecWithCode's settings. You can close this tab.`,
        }),
      ),
      Effect.catch((error) => Effect.succeed(callbackPage({ ok: false, message: error.detail }))),
    );

  const setProjectAccess = (input: GoogleAccountSetProjectAccessInput) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const project = yield* projects
          .get(input.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          return yield* fail("That project no longer exists.");
        }
        const state = yield* Ref.get(stateRef);
        yield* persistState(withProjectAccess(state, input.projectId, input.services));
        return yield* status;
      }),
    );

  const disconnect = writes.withPermits(1)(
    Effect.gen(function* () {
      yield* revokeAndForget;
      yield* Ref.set(pendingRef, null);
      yield* Ref.set(lastErrorRef, null);
      return yield* status;
    }),
  );

  /** Forgets everything; a build that ships a client can connect again right away. */
  const remove = Effect.gen(function* () {
    yield* disconnect;
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        yield* secrets.remove(GOOGLE_CLIENT_SECRET).pipe(Effect.ignore);
        yield* secrets.remove(GOOGLE_STATE_SECRET).pipe(Effect.ignore);
        yield* Ref.set(clientRef, Option.none());
        yield* Ref.set(stateRef, EMPTY_GOOGLE_ACCOUNT_STATE);
      }),
    );
    return yield* status;
  });

  // --- Agent reads ---------------------------------------------------------

  const accessToken = (forceRefresh: boolean) =>
    tokenLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* Ref.get(accessRef);
        if (!forceRefresh && cached !== null && cached.expiresAt - 60_000 > now)
          return cached.token;
        const client = yield* currentClient;
        const refresh = yield* Ref.get(refreshRef);
        if (Option.isNone(client) || Option.isNone(refresh)) {
          return yield* fail(
            "The Google account is not connected. The user can sign in under Settings > Google.",
          );
        }
        const tokens = yield* api
          .refresh({
            clientId: client.value.clientId,
            clientSecret: client.value.clientSecret,
            refreshToken: refresh.value,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                if (
                  error.reason === "invalid_grant" ||
                  error.reason === "unauthorized_client" ||
                  error.reason === "invalid_client" ||
                  error.reason === "deleted_client"
                ) {
                  // Revoked or expired at Google, or obtained by a client Studio no longer
                  // uses; a new sign-in is the only fix.
                  yield* forgetSignIn;
                  yield* Ref.set(
                    lastErrorRef,
                    "Google ended SpecWithCode's access. Sign in again.",
                  );
                  return yield* fail(
                    "Google ended SpecWithCode's access. The user needs to sign in again under Settings > Google.",
                  );
                }
                yield* Ref.set(lastErrorRef, error.message);
                return yield* fail(error.message);
              }),
            ),
          );
        if (tokens.refreshToken !== null) {
          yield* secrets
            .set(
              GOOGLE_REFRESH_TOKEN_SECRET,
              textEncoder.encode(Redacted.value(tokens.refreshToken)),
            )
            .pipe(Effect.ignore);
          yield* Ref.set(refreshRef, Option.some(tokens.refreshToken));
        }
        const next = { token: tokens.accessToken, expiresAt: now + tokens.expiresInSeconds * 1000 };
        yield* Ref.set(accessRef, next);
        yield* Ref.set(lastErrorRef, null);
        return next.token;
      }),
    );

  const requireService = (projectId: ProjectId, service: GoogleService) =>
    Effect.gen(function* () {
      const refresh = yield* Ref.get(refreshRef);
      if (Option.isNone(refresh)) {
        return yield* fail(
          "The Google account is not connected. The user can sign in under Settings > Google.",
        );
      }
      const state = yield* Ref.get(stateRef);
      if (!projectServices(state, projectId).includes(service)) {
        return yield* fail(
          `${SERVICE_LABEL[service]} is not turned on for this project. The user can turn it on under Settings > Google.`,
        );
      }
    });

  const toAccountError = (error: GoogleApi.GoogleApiError) =>
    new GoogleAccountError({
      detail:
        error.status === 403
          ? `${error.message} Google refused the request; the user may have unticked this service at sign-in.`
          : error.status === 404
            ? "Google could not find that item."
            : error.message,
    });

  /** One authorized call, retried once with a fresh token after a 401. */
  const withRawToken = <A>(
    call: (token: Redacted.Redacted<string>) => Effect.Effect<A, GoogleApi.GoogleApiError>,
  ) =>
    accessToken(false).pipe(
      Effect.flatMap((token) =>
        call(token).pipe(
          Effect.catchIf(
            (error) => error.status === 401,
            () => accessToken(true).pipe(Effect.flatMap(call)),
          ),
        ),
      ),
    );

  const withToken = <A>(
    call: (token: Redacted.Redacted<string>) => Effect.Effect<A, GoogleApi.GoogleApiError>,
  ) =>
    withRawToken(call).pipe(
      Effect.mapError((error) => (isAccountError(error) ? error : toAccountError(error))),
    );

  const gmailSearch = (projectId: ProjectId, input: GmailSearchInput) =>
    Effect.gen(function* () {
      yield* requireService(projectId, "gmail");
      const maxResults = clamp(input.maxResults, 10, 25);
      const list = (yield* withToken((token) =>
        api.getJson({
          operation: "Gmail search",
          url: `${api.endpoints.gmail}/users/me/messages`,
          query: { q: input.query.slice(0, 500), maxResults: String(maxResults) },
          accessToken: token,
        }),
      )) as { messages?: ReadonlyArray<{ id: string }>; nextPageToken?: string };
      const ids = (list.messages ?? [])
        .map((message) => message.id)
        .filter((id) => GOOGLE_ID.test(id));
      const messages = yield* Effect.forEach(
        ids,
        (id) =>
          withToken((token) =>
            api.getJson({
              operation: "Gmail message",
              url: `${api.endpoints.gmail}/users/me/messages/${id}`,
              query: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] },
              accessToken: token,
            }),
          ).pipe(Effect.map((message) => summarizeGmailMessage(message as GmailMessage))),
        { concurrency: 5 },
      );
      return { query: input.query, messages, more: list.nextPageToken !== undefined };
    });

  const gmailRead = (projectId: ProjectId, messageId: string) =>
    Effect.gen(function* () {
      yield* requireService(projectId, "gmail");
      if (!GOOGLE_ID.test(messageId)) return yield* fail("That is not a Gmail message id.");
      const message = yield* withToken((token) =>
        api.getJson({
          operation: "Gmail message",
          url: `${api.endpoints.gmail}/users/me/messages/${messageId}`,
          query: { format: "full" },
          accessToken: token,
        }),
      );
      return readGmailMessage(message as GmailMessage);
    });

  const gmailCreateDraft = (projectId: ProjectId, input: GmailCreateDraftInput) =>
    Effect.gen(function* () {
      yield* requireService(projectId, "gmail");
      yield* requireService(projectId, "gmailDrafts");
      if (!GOOGLE_ID.test(input.messageId)) return yield* fail("That is not a Gmail message id.");
      const body = input.body.trim();
      if (body === "") return yield* fail("A draft needs a reply text.");
      if (body.length > GMAIL_DRAFT_BODY_LIMIT) {
        return yield* fail(`A draft reply is at most ${GMAIL_DRAFT_BODY_LIMIT} characters.`);
      }
      const original = (yield* withToken((token) =>
        api.getJson({
          operation: "Gmail message",
          url: `${api.endpoints.gmail}/users/me/messages/${input.messageId}`,
          query: {
            format: "metadata",
            metadataHeaders: ["From", "To", "Reply-To", "Subject", "Message-ID", "References"],
          },
          accessToken: token,
        }),
      )) as GmailMessage;
      const state = yield* Ref.get(stateRef);
      const reply = buildGmailReplyDraft({ message: original, body, selfEmail: state.email });
      if (reply === null) return yield* fail("That message names nobody to reply to.");
      const saved = (yield* withToken((token) =>
        api.postJson({
          operation: "Gmail draft",
          url: `${api.endpoints.gmail}/users/me/drafts`,
          body: {
            message: {
              raw: reply.raw,
              ...(original.threadId ? { threadId: original.threadId } : {}),
            },
          },
          accessToken: token,
        }),
      )) as { id?: string; message?: { id?: string; threadId?: string } };
      if (typeof saved.id !== "string") return yield* fail("Gmail did not confirm the draft.");
      return {
        draftId: saved.id,
        threadId: saved.message?.threadId ?? original.threadId ?? null,
        to: reply.to,
        subject: reply.subject,
        link: saved.message?.id ? gmailDraftLink(saved.message.id) : null,
        sent: false as const,
      };
    });

  const validTime = (value: string | undefined, fallback: number) =>
    value === undefined
      ? Effect.succeed(isoAt(fallback))
      : Number.isFinite(Date.parse(value))
        ? Effect.succeed(isoAt(Date.parse(value)))
        : fail(
            `"${value.slice(0, 40)}" is not a date and time. Use ISO 8601, such as 2026-10-11T00:00:00Z.`,
          );

  const calendarEvents = (projectId: ProjectId, input: CalendarEventsInput) =>
    Effect.gen(function* () {
      yield* requireService(projectId, "calendar");
      const now = yield* Clock.currentTimeMillis;
      const timeMin = yield* validTime(input.timeMin, now);
      const timeMax = yield* validTime(input.timeMax, Date.parse(timeMin) + 7 * 24 * 60 * 60_000);
      const body = (yield* withToken((token) =>
        api.getJson({
          operation: "Calendar events",
          url: `${api.endpoints.calendar}/calendars/primary/events`,
          query: {
            timeMin,
            timeMax,
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: String(clamp(input.maxResults, 25, 100)),
            q: input.query?.slice(0, 200) || undefined,
          },
          accessToken: token,
        }),
      )) as { items?: ReadonlyArray<CalendarEvent>; timeZone?: string };
      return {
        calendar: "primary",
        timeZone: body.timeZone ?? null,
        timeMin,
        timeMax,
        events: (body.items ?? [])
          .filter((event) => event.status !== "cancelled")
          .map(summarizeCalendarEvent),
      };
    });

  const driveSearch = (projectId: ProjectId, input: DriveSearchInput) =>
    Effect.gen(function* () {
      yield* requireService(projectId, "drive");
      if (input.modifiedAfter !== undefined && !Number.isFinite(Date.parse(input.modifiedAfter))) {
        return yield* fail("modifiedAfter must be an ISO 8601 date and time.");
      }
      const body = (yield* withToken((token) =>
        api.getJson({
          operation: "Drive search",
          url: `${api.endpoints.drive}/files`,
          query: {
            q: driveQuery({
              ...(input.text === undefined ? {} : { text: input.text }),
              ...(input.modifiedAfter === undefined
                ? {}
                : { modifiedAfter: isoAt(Date.parse(input.modifiedAfter)) }),
            }),
            pageSize: String(clamp(input.maxResults, 15, 50)),
            orderBy: "modifiedTime desc",
            fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
          },
          accessToken: token,
        }),
      )) as { files?: ReadonlyArray<DriveFile>; nextPageToken?: string };
      return {
        files: (body.files ?? []).map(summarizeDriveFile),
        more: body.nextPageToken !== undefined,
      };
    });

  const driveRead = (projectId: ProjectId, fileId: string) =>
    Effect.gen(function* () {
      yield* requireService(projectId, "drive");
      if (!GOOGLE_ID.test(fileId)) return yield* fail("That is not a Drive file id.");
      const file = (yield* withToken((token) =>
        api.getJson({
          operation: "Drive file",
          url: `${api.endpoints.drive}/files/${fileId}`,
          query: { fields: DRIVE_FILE_FIELDS },
          accessToken: token,
        }),
      )) as DriveFile;
      const summary = summarizeDriveFile(file);
      const exportType = file.mimeType ? DRIVE_EXPORT_TYPES[file.mimeType] : undefined;
      if (exportType === undefined && !isReadableDriveType(file.mimeType)) {
        return {
          file: summary,
          content: null,
          note: "SpecWithCode reads Google Docs, Sheets, Slides and text files. This file type was not read.",
        };
      }
      const content = yield* withToken((token) =>
        exportType !== undefined
          ? api.getText({
              operation: "Drive export",
              url: `${api.endpoints.drive}/files/${fileId}/export`,
              query: { mimeType: exportType },
              accessToken: token,
              maxBytes: DRIVE_DOWNLOAD_LIMIT_BYTES,
            })
          : api.getText({
              operation: "Drive download",
              url: `${api.endpoints.drive}/files/${fileId}`,
              query: { alt: "media" },
              accessToken: token,
              maxBytes: DRIVE_DOWNLOAD_LIMIT_BYTES,
            }),
      );
      return { file: summary, content: truncateText(content, DRIVE_TEXT_LIMIT), note: null };
    });

  const projectStatus = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const client = yield* currentClient;
      const refresh = yield* Ref.get(refreshRef);
      const state = yield* Ref.get(stateRef);
      return projectGoogleStatus({
        clientConfigured: Option.isSome(client),
        connected: Option.isSome(refresh),
        email: state.email,
        grantedServices: state.services,
        projectServices:
          state.projects.find((project) => project.projectId === projectId)?.services ?? [],
      });
    });

  const projectAccess = (
    projectId: ProjectId,
    input?: { readonly checkConnection?: boolean | undefined },
  ) =>
    Effect.gen(function* () {
      const initial = yield* projectStatus(projectId);
      // Status discovery never refreshes tokens or contacts Google by default.
      if (!input?.checkConnection || initial.services.length === 0) return initial;
      const checks = yield* Effect.forEach(initial.services, (service) =>
        requireService(projectId, service).pipe(
          Effect.andThen(
            withRawToken((accessToken) =>
              api.getJson({
                ...googleHealthRequest(service, api.endpoints),
                accessToken,
              }),
            ),
          ),
          // Discard every byte of the API body, even if Google ignores its field mask.
          Effect.as({ service, status: "ok", message: null } satisfies GoogleServiceCheck),
          Effect.catch((error) => Effect.succeed(googleHealthFailure(service, error))),
        ),
      );
      // A failed refresh can have removed the sign-in, or the user may have changed grants.
      const current = yield* projectStatus(projectId);
      const authorized = new Set(
        current.serviceChecks
          .filter((check) => check.status !== "not_authorized")
          .map((check) => check.service),
      );
      const visibleChecks = checks.filter(
        (check) =>
          authorized.has(check.service) &&
          (check.status !== "ok" || current.services.includes(check.service)),
      );
      const failed = visibleChecks.some((check) => check.status !== "ok");
      const verified = current.services.every((service) =>
        visibleChecks.some((check) => check.service === service && check.status === "ok"),
      );
      const checkedAt = isoAt(yield* Clock.currentTimeMillis);
      return {
        ...current,
        connectionState:
          current.connectionState !== "configured"
            ? current.connectionState
            : failed
              ? "error"
              : verified
                ? "verified"
                : "configured",
        guidance:
          current.connectionState !== "configured"
            ? current.guidance
            : failed
              ? "Some authorized Google services failed their live check. Follow each service's message."
              : verified
                ? "The authorized Google services answered live read-only checks. No mail, event or file content was returned."
                : "Project access changed during the check. Run checkConnection: true again to verify the current services.",
        checkedAt,
        serviceChecks: current.serviceChecks.map(
          (check) => visibleChecks.find((result) => result.service === check.service) ?? check,
        ),
      } satisfies GoogleProjectStatus;
    });

  return GoogleAccountService.of({
    status,
    configureClient,
    startSignIn,
    completeSignIn,
    callbackPage: renderCallback,
    setProjectAccess,
    disconnect,
    remove,
    projectAccess,
    gmailSearch,
    gmailRead,
    gmailCreateDraft,
    calendarEvents,
    driveSearch,
    driveRead,
  });
});

export const layer = Layer.effect(GoogleAccountService, make);
