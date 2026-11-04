/** Google accounts, per-project access, reads, drafts, and explicitly approved immutable sends. */
// @effect-diagnostics-next-line nodeBuiltinImport:off - a pure, synchronous id hash; Effect Crypto would make the id builder effectful.
import * as NodeCrypto from "node:crypto";
import {
  GoogleAccountError,
  type GoogleAccountConfigureClientInput,
  type GoogleAccountDisconnectInput,
  type GoogleAccountSetLabelInput,
  type GoogleAccountSetProjectAccessInput,
  type GoogleAccountStartSignInInput,
  type GoogleAccountStatus,
  type GoogleService,
  type ProjectId,
} from "@specweave-studio/contracts";
import { teamRulesToolRefusal } from "@specweave-studio/shared/teamRules";
import { currentTeamRules } from "../../teamRules/TeamRules.ts";
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
import * as GmailSendApproval from "./GmailSendApproval.ts";
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
  ACCOUNT_LABEL_LIMIT,
  accountForSignIn,
  accountName,
  emailFromIdToken,
  EMPTY_GOOGLE_ACCOUNT_STATE,
  GMAIL_DRAFT_BODY_LIMIT,
  gmailDraftLink,
  GOOGLE_CALLBACK_PATH,
  GoogleAccountState,
  type GoogleStoredAccount,
  isReadableDriveType,
  matchAccount,
  MAX_GOOGLE_ACCOUNTS,
  orderedServices,
  parseCallback,
  projectServices,
  readGmailDraft,
  readGmailMessage,
  servicesFromScope,
  SIGN_IN_TTL_MS,
  summarizeCalendarEvent,
  summarizeDriveFile,
  summarizeGmailMessage,
  truncateText,
  personalProjectAccess,
  PRIMARY_ACCOUNT_ID,
  projectDefaultAccount,
  qualifiedId,
  readGoogleAccountState,
  splitQualifiedId,
  withoutAccount,
  withProjectAccess,
  withProjectDefault,
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

/** The primary account keeps the secret name it had when a host kept one account. */
export const refreshSecretName = (accountId: string) =>
  accountId === PRIMARY_ACCOUNT_ID
    ? GOOGLE_REFRESH_TOKEN_SECRET
    : `${GOOGLE_REFRESH_TOKEN_SECRET}-${accountId}`;

/** A stable id for an added account, from its address. */
const accountIdFor = (email: string | null, salt: string) =>
  NodeCrypto.createHash("sha256")
    .update(email === null ? `unnamed:${salt}` : email.trim().toLowerCase())
    .digest("hex")
    .slice(0, 12);

const StoredClient = Schema.Struct({ clientId: Schema.String, clientSecret: Schema.String });
const decodeClient = Schema.decodeUnknownExit(Schema.fromJsonString(StoredClient));
const encodeClient = Schema.encodeSync(Schema.fromJsonString(StoredClient));
const encodeState = Schema.encodeSync(Schema.fromJsonString(GoogleAccountState));
const isAccountError = Schema.is(GoogleAccountError);

/** Which account a call uses: an address, label or id; "all" where a tool says so. */
export interface AccountChoice {
  readonly account?: string | undefined;
}
export interface GmailSearchInput extends AccountChoice {
  readonly query: string;
  readonly maxResults?: number | undefined;
}
export interface CalendarEventsInput extends AccountChoice {
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
export interface DriveSearchInput extends AccountChoice {
  readonly text?: string | undefined;
  readonly modifiedAfter?: string | undefined;
  readonly maxResults?: number | undefined;
}

export type GmailDraftView = NonNullable<ReturnType<typeof readGmailDraft>> & {
  /** The address the draft is sent from. */
  readonly from: string | null;
};

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
    readonly setLabel: (
      input: GoogleAccountSetLabelInput,
    ) => Effect.Effect<GoogleAccountStatus, GoogleAccountError>;
    /**
     * Revokes and forgets one account's sign-in, or every account's. Keeps the OAuth
     * client and the project switches unless `forget` is set.
     */
    readonly disconnect: (
      input?: GoogleAccountDisconnectInput,
    ) => Effect.Effect<GoogleAccountStatus, GoogleAccountError>;
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
     * Saves a reply draft in the mailbox the message came to, threaded under it.
     * It is never sent: the person reviews and sends it.
     */
    readonly gmailCreateDraft: (
      projectId: ProjectId,
      input: GmailCreateDraftInput,
    ) => Effect.Effect<
      {
        readonly draftId: string;
        readonly threadId: string | null;
        readonly from: string | null;
        readonly to: string;
        readonly subject: string;
        readonly link: string | null;
        readonly sent: false;
      },
      GoogleAccountError
    >;
    /** One saved draft, read so the person sees exactly what would be sent and from where. */
    readonly gmailDraft: (
      projectId: ProjectId,
      draftId: string,
    ) => Effect.Effect<GmailDraftView, GoogleAccountError>;
    readonly gmailPrepareSend: (
      projectId: ProjectId,
      chatId: string,
      draftId: string,
    ) => Effect.Effect<GmailSendApproval.GmailApprovalPreview, GoogleAccountError>;
    /**
     * Sends an immutable approved copy, retaining the source draft. Only the reply card's Send answer may lead here: the
     * caller checks that answer before calling, and nothing else in Studio sends mail.
     */
    readonly gmailSendDraft: (
      projectId: ProjectId,
      draftId: string,
      chatId: string,
      snapshotId: string,
    ) => Effect.Effect<
      {
        readonly sent: true;
        readonly sourceDraftRetained: true;
        readonly from: string | null;
        readonly messageId: string | null;
        readonly threadId: string | null;
      },
      GoogleAccountError
    >;
    readonly calendarEvents: (
      projectId: ProjectId,
      input: CalendarEventsInput,
    ) => Effect.Effect<unknown, GoogleAccountError>;
    /**
     * What the briefing setup needs, across every connected account: an address when
     * any is connected, each project's readable services and where it was set up.
     */
    readonly briefingState: Effect.Effect<{
      readonly email: string | null;
      readonly projects: ReadonlyArray<{
        readonly projectId: string;
        readonly services: ReadonlyArray<GoogleService>;
      }>;
      readonly services: ReadonlyArray<GoogleService>;
      readonly briefingSetUp: ReadonlyArray<string>;
    }>;
    /** Records that the briefing was set up for this project with the connected accounts. */
    readonly markBriefingSetUp: (projectId: ProjectId) => Effect.Effect<void, GoogleAccountError>;
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
  /** The saved account Reconnect was pressed for, or null for a new sign-in. */
  readonly account: string | null;
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
  const primaryRefresh = yield* readSecret(GOOGLE_REFRESH_TOKEN_SECRET);
  const initialState = readGoogleAccountState(
    Option.getOrNull(yield* readSecret(GOOGLE_STATE_SECRET)),
    Option.isSome(primaryRefresh),
  );
  const initialRefresh = new Map<string, Redacted.Redacted<string>>();
  for (const account of initialState.accounts) {
    const token =
      account.id === PRIMARY_ACCOUNT_ID
        ? primaryRefresh
        : yield* readSecret(refreshSecretName(account.id));
    if (Option.isSome(token)) initialRefresh.set(account.id, Redacted.make(token.value));
  }

  const clientRef = yield* Ref.make(initialClient);
  const stateRef = yield* Ref.make(initialState);
  /** Refresh tokens by account id; an account without one is disconnected. */
  const refreshRef =
    yield* Ref.make<ReadonlyMap<string, Redacted.Redacted<string>>>(initialRefresh);
  const accessRef = yield* Ref.make<ReadonlyMap<string, CachedAccessToken>>(new Map());
  const pendingRef = yield* Ref.make<PendingSignIn | null>(null);
  /** The last failure that belongs to no one account, such as a failed sign-in. */
  const lastErrorRef = yield* Ref.make<string | null>(null);
  const accountErrorsRef = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

  const fail = (detail: string) => Effect.fail(new GoogleAccountError({ detail }));
  const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
  const redirectUri = `http://127.0.0.1:${config.port}${GOOGLE_CALLBACK_PATH}`;

  const withEntry = <V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined) => {
    const next = new Map(map);
    if (value === undefined) next.delete(key);
    else next.set(key, value);
    return next;
  };
  const setAccountError = (accountId: string, message: string | undefined) =>
    Ref.update(accountErrorsRef, (errors) => withEntry(errors, accountId, message));

  /** The person's own client wins over the one shipped with Studio. */
  const effectiveClient = (own: Option.Option<GoogleOAuthClient>) =>
    Option.isSome(own) ? own : Option.fromNullishOr(builtInClient);
  const currentClient = Ref.get(clientRef).pipe(Effect.map(effectiveClient));
  const NO_CLIENT = "Save an OAuth client before signing in.";
  const NOT_CONNECTED =
    "No Google account is connected. The user can sign in under Settings > Google.";

  const persistState = (state: GoogleAccountState) =>
    secrets.set(GOOGLE_STATE_SECRET, textEncoder.encode(encodeState(state))).pipe(
      Effect.andThen(Ref.set(stateRef, state)),
      Effect.mapError(
        () =>
          new GoogleAccountError({ detail: "SpecWithCode could not save the Google settings." }),
      ),
    );

  const updateAccount = (
    state: GoogleAccountState,
    accountId: string,
    change: (account: GoogleStoredAccount) => GoogleStoredAccount,
  ): GoogleAccountState => ({
    ...state,
    accounts: state.accounts.map((account) =>
      account.id === accountId ? change(account) : account,
    ),
  });

  // A refresh token works only with the client that obtained it. When the client changed
  // since (a new Studio build or a removed own client), that saved sign-in cannot be used.
  const startupClient = effectiveClient(initialClient);
  let startupState = initialState;
  for (const account of initialState.accounts) {
    if (
      initialRefresh.has(account.id) &&
      account.clientId != null &&
      (Option.isNone(startupClient) || startupClient.value.clientId !== account.clientId)
    ) {
      yield* secrets.remove(refreshSecretName(account.id)).pipe(Effect.ignore);
      yield* Ref.update(refreshRef, (tokens) => withEntry(tokens, account.id, undefined));
      startupState = updateAccount(startupState, account.id, (stored) => ({
        ...stored,
        clientId: null,
        services: [],
      }));
      yield* setAccountError(account.id, "SpecWithCode's Google client changed. Connect again.");
    }
  }
  if (startupState !== initialState) yield* persistState(startupState).pipe(Effect.ignore);

  const status: Effect.Effect<GoogleAccountStatus> = Effect.gen(function* () {
    const client = yield* Ref.get(clientRef);
    const state = yield* Ref.get(stateRef);
    const tokens = yield* Ref.get(refreshRef);
    const errors = yield* Ref.get(accountErrorsRef);
    const pending = yield* Ref.get(pendingRef);
    const now = yield* Clock.currentTimeMillis;
    const accounts = state.accounts.map((account) => {
      const connected = tokens.has(account.id);
      return {
        id: account.id,
        email: account.email,
        label: account.label ?? null,
        connected,
        services: connected ? [...account.services] : [],
        projects: state.projects
          .filter((entry) => entry.account === account.id)
          .map((entry) => ({
            projectId: entry.projectId as ProjectId,
            services: [...entry.services],
          })),
        lastError: errors.get(account.id) ?? null,
      };
    });
    // Older clients know one account: show them the first connected one.
    const first = accounts.find((account) => account.connected) ?? accounts[0];
    const connected = first?.connected === true;
    return {
      clientConfigured: Option.isSome(client) || builtInClient !== null,
      clientId: Option.isSome(client) ? client.value.clientId : null,
      clientSource: Option.isSome(client) ? "own" : builtInClient !== null ? "studio" : null,
      connected,
      email: connected ? first.email : null,
      services: connected ? first.services : [],
      projects: first?.projects ?? [],
      signIn:
        pending !== null && pending.expiresAt > now
          ? {
              authorizationUrl: pending.authorizationUrl,
              redirectUri: pending.redirectUri,
              expiresAt: isoAt(pending.expiresAt),
            }
          : null,
      lastError: (yield* Ref.get(lastErrorRef)) ?? first?.lastError ?? null,
      accounts,
      defaults: (state.defaults ?? []).map((entry) => ({
        projectId: entry.projectId as ProjectId,
        account: entry.account,
      })),
    } satisfies GoogleAccountStatus;
  });

  /** Drops one account's sign-in locally; the caller decides whether to revoke it first. */
  const forgetSignIn = (accountId: string) =>
    Effect.gen(function* () {
      yield* secrets.remove(refreshSecretName(accountId)).pipe(Effect.ignore);
      yield* Ref.update(refreshRef, (tokens) => withEntry(tokens, accountId, undefined));
      yield* Ref.update(accessRef, (tokens) => withEntry(tokens, accountId, undefined));
    });

  /**
   * Revokes these accounts' sign-ins at Google (best effort), then forgets them here.
   * Holds the token lock so a refresh already in flight cannot bring one back.
   */
  const revokeAndForget = (accountIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* tokenLock.withPermits(1)(
        Effect.forEach(accountIds, (accountId) =>
          Effect.gen(function* () {
            const refresh = (yield* Ref.get(refreshRef)).get(accountId);
            if (refresh !== undefined) {
              // Best effort: the local copy is forgotten whether or not Google answers.
              yield* api.revoke(refresh).pipe(Effect.ignore);
            }
            yield* forgetSignIn(accountId);
          }),
        ),
      );
      let state = yield* Ref.get(stateRef);
      for (const accountId of accountIds) {
        state = updateAccount(state, accountId, (account) => ({
          ...account,
          clientId: null,
          services: [],
        }));
        yield* setAccountError(accountId, undefined);
      }
      yield* persistState(state);
    });

  const allAccountIds = Ref.get(stateRef).pipe(
    Effect.map((state) => state.accounts.map((account) => account.id)),
  );

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
          yield* revokeAndForget(yield* allAccountIds);
        }
        yield* Ref.set(pendingRef, null);
        yield* Ref.set(lastErrorRef, null);
        return yield* status;
      }),
    );

  /** Team rules stop new sign-ins and token use. Disconnect stays, so access can always be removed. */
  const refuseByTeamRules = Effect.gen(function* () {
    const refused = teamRulesToolRefusal(yield* currentTeamRules, "google");
    if (refused !== null) return yield* fail(refused.message);
  });

  /** A saved account by id, for the settings calls. */
  const savedAccount = (accountId: string) =>
    Effect.gen(function* () {
      const account = (yield* Ref.get(stateRef)).accounts.find(
        (candidate) => candidate.id === accountId,
      );
      if (account === undefined) return yield* fail("That Google account is not saved here.");
      return account;
    });

  const startSignIn = (input: GoogleAccountStartSignInInput) =>
    Effect.gen(function* () {
      yield* refuseByTeamRules;
      const client = yield* currentClient;
      if (Option.isNone(client)) return yield* fail(NO_CLIENT);
      const services = orderedServices(input.services);
      if (services.length === 0) return yield* fail("Choose at least one Google service.");
      const reconnect = input.account === undefined ? null : yield* savedAccount(input.account);
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
        loginHint: reconnect?.email ?? null,
      });
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.set(pendingRef, {
        state,
        codeVerifier,
        redirectUri,
        authorizationUrl,
        expiresAt: now + SIGN_IN_TTL_MS,
        account: reconnect?.id ?? null,
      });
      yield* Ref.set(lastErrorRef, null);
      return yield* status;
    });

  const completeSignIn = (input: { readonly callbackUrl: string }) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        yield* refuseByTeamRules;
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
        const connectedIds = new Set((yield* Ref.get(refreshRef)).keys());
        // Reconnecting a saved account keeps its switches. Any other address is added
        // beside the saved ones and starts with its personal projects only.
        const existing = accountForSignIn(previous, email, connectedIds, pending.account);
        if (existing === undefined && previous.accounts.length >= MAX_GOOGLE_ACCOUNTS) {
          return yield* fail(
            `SpecWithCode keeps at most ${MAX_GOOGLE_ACCOUNTS} Google accounts. Remove one before adding another.`,
          );
        }
        const accountId =
          existing?.id ??
          (previous.accounts.some((account) => account.id === PRIMARY_ACCOUNT_ID)
            ? accountIdFor(email, String(now))
            : PRIMARY_ACCOUNT_ID);
        const projectAccess =
          existing === undefined
            ? [
                ...previous.projects.filter((entry) => entry.account !== accountId),
                ...personalProjectAccess(
                  yield* projects.list().pipe(Effect.orElseSucceed(() => [])),
                  accountId,
                  services,
                ),
              ]
            : previous.projects;
        const account: GoogleStoredAccount = {
          ...existing,
          id: accountId,
          email: email ?? existing?.email ?? null,
          clientId: client.value.clientId,
          services,
          briefingSetUp: existing?.briefingSetUp ?? [],
        };
        // State first, so a token is never held for an account the state does not list.
        yield* persistState({
          ...previous,
          accounts:
            existing === undefined
              ? [...previous.accounts, account]
              : previous.accounts.map((candidate) =>
                  candidate.id === accountId ? account : candidate,
                ),
          projects: projectAccess,
        });
        // Under the token lock, so a refresh of the previous sign-in cannot overwrite this one.
        yield* tokenLock.withPermits(1)(
          Effect.gen(function* () {
            yield* secrets
              .set(refreshSecretName(accountId), textEncoder.encode(Redacted.value(refreshToken)))
              .pipe(
                // A new account whose token could not be saved is not kept half-added.
                Effect.tapError(() =>
                  existing === undefined ? persistState(previous).pipe(Effect.ignore) : Effect.void,
                ),
                Effect.mapError(
                  () =>
                    new GoogleAccountError({ detail: "SpecWithCode could not save the sign-in." }),
                ),
              );
            yield* Ref.update(refreshRef, (saved) => withEntry(saved, accountId, refreshToken));
            yield* Ref.update(accessRef, (saved) =>
              withEntry(saved, accountId, {
                token: tokens.accessToken,
                expiresAt: now + tokens.expiresInSeconds * 1000,
              }),
            );
          }),
        );
        yield* setAccountError(accountId, undefined);
        yield* Ref.set(lastErrorRef, null);
        return { status: yield* status, account };
      }),
    );

  const renderCallback = (callbackUrl: string) =>
    completeSignIn({ callbackUrl }).pipe(
      Effect.map(({ account }) =>
        callbackPage({
          ok: true,
          message: `SpecWithCode can now read ${account.services.map((s) => SERVICE_LABEL[s]).join(", ") || "nothing yet"}${account.email ? ` for ${account.email}` : ""}. Personal projects can use it now; turn it on for other projects in SpecWithCode's settings. You can close this tab.`,
        }),
      ),
      Effect.catch((error) => Effect.succeed(callbackPage({ ok: false, message: error.detail }))),
    );

  /** The account a settings call without one means: the first connected, as older clients expect. */
  const firstAccount = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const tokens = yield* Ref.get(refreshRef);
    return state.accounts.find((account) => tokens.has(account.id)) ?? state.accounts[0];
  });

  const setProjectAccess = (input: GoogleAccountSetProjectAccessInput) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const project = yield* projects
          .get(input.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          return yield* fail("That project no longer exists.");
        }
        const account =
          input.account === undefined ? yield* firstAccount : yield* savedAccount(input.account);
        if (account === undefined) return yield* fail("Connect a Google account first.");
        let state = withProjectAccess(
          yield* Ref.get(stateRef),
          input.projectId,
          account.id,
          input.services,
        );
        if (input.makeDefault === true)
          state = withProjectDefault(state, input.projectId, account.id);
        yield* persistState(state);
        return yield* status;
      }),
    );

  const setLabel = (input: GoogleAccountSetLabelInput) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        yield* savedAccount(input.account);
        const label =
          input.label?.replace(/\s+/gu, " ").trim().slice(0, ACCOUNT_LABEL_LIMIT) || null;
        yield* persistState(
          updateAccount(yield* Ref.get(stateRef), input.account, (account) => ({
            ...account,
            label,
          })),
        );
        return yield* status;
      }),
    );

  const disconnect = (input?: GoogleAccountDisconnectInput) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const ids =
          input?.account === undefined
            ? yield* allAccountIds
            : [(yield* savedAccount(input.account)).id];
        yield* revokeAndForget(ids);
        if (input?.forget === true) {
          let state = yield* Ref.get(stateRef);
          for (const accountId of ids) state = withoutAccount(state, accountId);
          yield* persistState(state);
        }
        // A sign-in in progress for another account carries on.
        yield* Ref.update(pendingRef, (pending) =>
          input?.account === undefined || (pending !== null && ids.includes(pending.account ?? ""))
            ? null
            : pending,
        );
        yield* Ref.set(lastErrorRef, null);
        return yield* status;
      }),
    );

  /** Forgets everything; a build that ships a client can connect again right away. */
  const remove = Effect.gen(function* () {
    yield* disconnect();
    yield* writes.withPermits(1)(
      Effect.gen(function* () {
        yield* secrets.remove(GOOGLE_CLIENT_SECRET).pipe(Effect.ignore);
        yield* secrets.remove(GOOGLE_STATE_SECRET).pipe(Effect.ignore);
        yield* Ref.set(clientRef, Option.none());
        yield* Ref.set(stateRef, EMPTY_GOOGLE_ACCOUNT_STATE);
        yield* Ref.set(accountErrorsRef, new Map());
      }),
    );
    return yield* status;
  });

  // --- Agent reads ---------------------------------------------------------

  const accessToken = (account: GoogleStoredAccount, forceRefresh: boolean) =>
    tokenLock.withPermits(1)(
      Effect.gen(function* () {
        yield* refuseByTeamRules;
        const now = yield* Clock.currentTimeMillis;
        const cached = (yield* Ref.get(accessRef)).get(account.id);
        if (!forceRefresh && cached !== undefined && cached.expiresAt - 60_000 > now)
          return cached.token;
        const client = yield* currentClient;
        const refresh = (yield* Ref.get(refreshRef)).get(account.id);
        if (Option.isNone(client) || refresh === undefined) {
          return yield* fail(
            `${accountName(account)} is not connected. The user can sign in under Settings > Google.`,
          );
        }
        const tokens = yield* api
          .refresh({
            clientId: client.value.clientId,
            clientSecret: client.value.clientSecret,
            refreshToken: refresh,
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
                  yield* forgetSignIn(account.id);
                  yield* setAccountError(
                    account.id,
                    "Google ended SpecWithCode's access. Sign in again.",
                  );
                  return yield* fail(
                    `Google ended SpecWithCode's access to ${accountName(account)}. The user needs to sign in again under Settings > Google.`,
                  );
                }
                yield* setAccountError(account.id, error.message);
                return yield* fail(error.message);
              }),
            ),
          );
        if (tokens.refreshToken !== null) {
          const rotated = tokens.refreshToken;
          yield* secrets
            .set(refreshSecretName(account.id), textEncoder.encode(Redacted.value(rotated)))
            .pipe(Effect.ignore);
          yield* Ref.update(refreshRef, (saved) => withEntry(saved, account.id, rotated));
        }
        const next = { token: tokens.accessToken, expiresAt: now + tokens.expiresInSeconds * 1000 };
        yield* Ref.update(accessRef, (saved) => withEntry(saved, account.id, next));
        yield* setAccountError(account.id, undefined);
        return next.token;
      }),
    );

  const usableFor =
    (
      state: GoogleAccountState,
      tokens: ReadonlyMap<string, unknown>,
      projectId: ProjectId,
      service: GoogleService,
    ) =>
    (accountId: string) =>
      tokens.has(accountId) && projectServices(state, projectId, accountId).includes(service);

  /** Why no account may serve this call: not connected, or not turned on for the project. */
  const unusableReason = (
    state: GoogleAccountState,
    tokens: ReadonlyMap<string, unknown>,
    service: GoogleService,
  ) =>
    state.accounts.some((account) => tokens.has(account.id))
      ? `${SERVICE_LABEL[service]} is not turned on for this project. The user can turn it on under Settings > Google.`
      : NOT_CONNECTED;

  const requireService = (projectId: ProjectId, service: GoogleService, accountId: string) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const tokens = yield* Ref.get(refreshRef);
      const account = state.accounts.find((candidate) => candidate.id === accountId);
      if (account === undefined) {
        return yield* fail(
          "That id belongs to a Google account that is no longer saved here. Search again.",
        );
      }
      // Checked before the account is named, and named only to a project that may use it,
      // so a project never learns an address it was not given.
      const allowed = projectServices(state, projectId, accountId);
      if (!allowed.includes(service)) {
        const which = allowed.length > 0 ? ` with ${accountName(account)}` : "";
        return yield* fail(
          `${SERVICE_LABEL[service]} is not turned on for this project${which}. The user can turn it on under Settings > Google.`,
        );
      }
      if (!tokens.has(accountId)) {
        return yield* fail(
          `${accountName(account)} is not connected. The user can sign in under Settings > Google.`,
        );
      }
      return account;
    });

  /**
   * The accounts a call reads: the named one, every usable one for "all", or the
   * project's default. A name that matches no usable account lists the ones it may use.
   */
  const chooseAccounts = (projectId: ProjectId, service: GoogleService, name: string | undefined) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const tokens = yield* Ref.get(refreshRef);
      const usable = usableFor(state, tokens, projectId, service);
      const allowed = state.accounts.filter((account) => usable(account.id));
      if (allowed.length === 0) return yield* fail(unusableReason(state, tokens, service));
      const wanted = name?.trim() ?? "";
      if (wanted === "") {
        const chosen = projectDefaultAccount(state, projectId, usable);
        return chosen === undefined ? allowed.slice(0, 1) : [chosen];
      }
      if (wanted.toLowerCase() === "all") return allowed;
      const match = matchAccount(state.accounts, wanted);
      if (match === undefined || !usable(match.id)) {
        return yield* fail(
          `No Google account "${wanted.slice(0, 80)}" may be used for ${SERVICE_LABEL[service]} in this project. It may use: ${allowed.map(accountName).join(", ")}.`,
        );
      }
      return [match];
    });

  /** The account a qualified id belongs to, checked for this project and service. */
  const accountOfId = (projectId: ProjectId, service: GoogleService, value: string, kind: string) =>
    Effect.gen(function* () {
      const { account, id } = splitQualifiedId(value);
      if (!GOOGLE_ID.test(id)) return yield* fail(`That is not a ${kind} id.`);
      return { account: yield* requireService(projectId, service, account), id };
    });

  /**
   * Runs a read for each chosen account. One account returns its result with the
   * account named; several return one entry each, so one failing account does not hide the rest.
   */
  const perAccount = <A extends object>(
    accounts: ReadonlyArray<GoogleStoredAccount>,
    run: (account: GoogleStoredAccount) => Effect.Effect<A, GoogleAccountError>,
  ) =>
    accounts.length === 1
      ? run(accounts[0]!).pipe(
          Effect.map((result) => ({ account: accountName(accounts[0]!), ...result })),
        )
      : Effect.forEach(
          accounts,
          (account) =>
            run(account).pipe(
              Effect.map((result) => ({ account: accountName(account), ...result })),
              Effect.catch((error) =>
                Effect.succeed({ account: accountName(account), error: error.detail }),
              ),
            ),
          { concurrency: 3 },
        ).pipe(Effect.map((results) => ({ accounts: results })));

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
    account: GoogleStoredAccount,
    call: (token: Redacted.Redacted<string>) => Effect.Effect<A, GoogleApi.GoogleApiError>,
  ) =>
    accessToken(account, false).pipe(
      Effect.flatMap((token) =>
        call(token).pipe(
          Effect.catchIf(
            (error) => error.status === 401,
            () => accessToken(account, true).pipe(Effect.flatMap(call)),
          ),
        ),
      ),
    );

  const withToken = <A>(
    account: GoogleStoredAccount,
    call: (token: Redacted.Redacted<string>) => Effect.Effect<A, GoogleApi.GoogleApiError>,
  ) =>
    withRawToken(account, call).pipe(
      Effect.mapError((error) => (isAccountError(error) ? error : toAccountError(error))),
    );

  const gmailSearch = (projectId: ProjectId, input: GmailSearchInput) =>
    Effect.gen(function* () {
      const accounts = yield* chooseAccounts(projectId, "gmail", input.account);
      const maxResults = clamp(input.maxResults, 10, 25);
      const result = yield* perAccount(accounts, (account) =>
        Effect.gen(function* () {
          const list = (yield* withToken(account, (token) =>
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
              withToken(account, (token) =>
                api.getJson({
                  operation: "Gmail message",
                  url: `${api.endpoints.gmail}/users/me/messages/${id}`,
                  query: { format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] },
                  accessToken: token,
                }),
              ).pipe(
                Effect.map((message) => {
                  const summary = summarizeGmailMessage(message as GmailMessage);
                  return { ...summary, id: qualifiedId(account.id, summary.id) };
                }),
              ),
            { concurrency: 5 },
          );
          return { messages, more: list.nextPageToken !== undefined };
        }),
      );
      return { query: input.query, ...result };
    });

  const gmailRead = (projectId: ProjectId, messageId: string) =>
    Effect.gen(function* () {
      const { account, id } = yield* accountOfId(projectId, "gmail", messageId, "Gmail message");
      const message = yield* withToken(account, (token) =>
        api.getJson({
          operation: "Gmail message",
          url: `${api.endpoints.gmail}/users/me/messages/${id}`,
          query: { format: "full" },
          accessToken: token,
        }),
      );
      const read = readGmailMessage(message as GmailMessage);
      return { ...read, id: qualifiedId(account.id, read.id), account: accountName(account) };
    });

  const gmailCreateDraft = (projectId: ProjectId, input: GmailCreateDraftInput) =>
    Effect.gen(function* () {
      const { account, id } = yield* accountOfId(
        projectId,
        "gmail",
        input.messageId,
        "Gmail message",
      );
      yield* requireService(projectId, "gmailDrafts", account.id);
      const body = input.body.trim();
      if (body === "") return yield* fail("A draft needs a reply text.");
      if (body.length > GMAIL_DRAFT_BODY_LIMIT) {
        return yield* fail(`A draft reply is at most ${GMAIL_DRAFT_BODY_LIMIT} characters.`);
      }
      const original = (yield* withToken(account, (token) =>
        api.getJson({
          operation: "Gmail message",
          url: `${api.endpoints.gmail}/users/me/messages/${id}`,
          query: {
            format: "metadata",
            metadataHeaders: ["From", "To", "Reply-To", "Subject", "Message-ID", "References"],
          },
          accessToken: token,
        }),
      )) as GmailMessage;
      const reply = buildGmailReplyDraft({ message: original, body, selfEmail: account.email });
      if (reply === null) return yield* fail("That message names nobody to reply to.");
      const saved = (yield* withToken(account, (token) =>
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
      if (typeof saved.id !== "string" || !GOOGLE_ID.test(saved.id)) {
        return yield* fail("Gmail did not confirm the draft.");
      }
      return {
        draftId: qualifiedId(account.id, saved.id),
        threadId: saved.message?.threadId ?? original.threadId ?? null,
        from: account.email ?? accountName(account),
        to: reply.to,
        subject: reply.subject,
        link: saved.message?.id ? gmailDraftLink(saved.message.id) : null,
        sent: false as const,
      };
    });

  const gmailDraft = (projectId: ProjectId, draftId: string) =>
    Effect.gen(function* () {
      const { account, id } = yield* accountOfId(projectId, "gmailDrafts", draftId, "Gmail draft");
      const draft = yield* withToken(account, (token) =>
        api.getJson({
          operation: "Gmail draft",
          url: `${api.endpoints.gmail}/users/me/drafts/${id}`,
          query: { format: "full" },
          accessToken: token,
        }),
      );
      const read = readGmailDraft(draft as { id?: string; message?: GmailMessage });
      if (read === null) return yield* fail("Gmail did not return that draft.");
      return {
        ...read,
        draftId: qualifiedId(account.id, read.draftId),
        from: account.email ?? accountName(account),
      };
    });

  const { gmailPrepareSend, gmailSendDraft } = yield* GmailSendApproval.makeSending({
    exclusive: (effect) => writes.withPermits(1)(effect),
    authorize: (projectId, draftId) =>
      Effect.gen(function* () {
        const { account, id } = yield* accountOfId(
          projectId,
          "gmailDrafts",
          draftId,
          "Gmail draft",
        );
        if (!account.email)
          return yield* fail(
            "The sending account has no verified address. Review this draft in Gmail.",
          );
        const token = yield* accessToken(account, false);
        const refresh = (yield* Ref.get(refreshRef)).get(account.id);
        if (!refresh) return yield* fail(NOT_CONNECTED);
        const accountKey = GmailSendApproval.accountFingerprint([
          account.id,
          account.email,
          account.clientId ?? "",
          Redacted.value(refresh),
        ]);
        return {
          accountId: account.id,
          email: account.email,
          id,
          token,
          accountKey,
        };
      }),
  });

  const briefingState = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const tokens = yield* Ref.get(refreshRef);
    const connected = state.accounts.filter((account) => tokens.has(account.id));
    const projectIds = [...new Set(state.projects.map((entry) => entry.projectId))];
    return {
      email:
        connected.find((account) => account.email !== null)?.email ?? connected[0]?.email ?? null,
      services: orderedServices(connected.flatMap((account) => account.services)),
      projects: projectIds.map((projectId) => ({
        projectId,
        services: orderedServices(
          connected.flatMap((account) => projectServices(state, projectId, account.id)),
        ),
      })),
      // Every saved account counts, so disconnecting one never brings back a deleted briefing.
      briefingSetUp: [...new Set(state.accounts.flatMap((account) => account.briefingSetUp ?? []))],
    };
  });

  const markBriefingSetUp = (projectId: ProjectId) =>
    writes.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        let next = state;
        for (const account of state.accounts) {
          const done = account.briefingSetUp ?? [];
          if (done.includes(projectId)) continue;
          next = updateAccount(next, account.id, (stored) => ({
            ...stored,
            briefingSetUp: [...done, projectId],
          }));
        }
        if (next !== state) yield* persistState(next);
      }),
    );

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
      const accounts = yield* chooseAccounts(projectId, "calendar", input.account);
      const now = yield* Clock.currentTimeMillis;
      const timeMin = yield* validTime(input.timeMin, now);
      const timeMax = yield* validTime(input.timeMax, Date.parse(timeMin) + 7 * 24 * 60 * 60_000);
      const result = yield* perAccount(accounts, (account) =>
        withToken(account, (token) =>
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
        ).pipe(
          Effect.map((raw) => {
            const body = raw as { items?: ReadonlyArray<CalendarEvent>; timeZone?: string };
            return {
              timeZone: body.timeZone ?? null,
              events: (body.items ?? [])
                .filter((event) => event.status !== "cancelled")
                .map(summarizeCalendarEvent),
            };
          }),
        ),
      );
      return { calendar: "primary", timeMin, timeMax, ...result };
    });

  const driveSearch = (projectId: ProjectId, input: DriveSearchInput) =>
    Effect.gen(function* () {
      const accounts = yield* chooseAccounts(projectId, "drive", input.account);
      if (input.modifiedAfter !== undefined && !Number.isFinite(Date.parse(input.modifiedAfter))) {
        return yield* fail("modifiedAfter must be an ISO 8601 date and time.");
      }
      return yield* perAccount(accounts, (account) =>
        withToken(account, (token) =>
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
        ).pipe(
          Effect.map((raw) => {
            const body = raw as { files?: ReadonlyArray<DriveFile>; nextPageToken?: string };
            return {
              files: (body.files ?? []).map((file) => {
                const summary = summarizeDriveFile(file);
                return { ...summary, id: qualifiedId(account.id, summary.id) };
              }),
              more: body.nextPageToken !== undefined,
            };
          }),
        ),
      );
    });

  const driveRead = (projectId: ProjectId, fileId: string) =>
    Effect.gen(function* () {
      const { account, id } = yield* accountOfId(projectId, "drive", fileId, "Drive file");
      const file = (yield* withToken(account, (token) =>
        api.getJson({
          operation: "Drive file",
          url: `${api.endpoints.drive}/files/${id}`,
          query: { fields: DRIVE_FILE_FIELDS },
          accessToken: token,
        }),
      )) as DriveFile;
      const summary = { ...summarizeDriveFile(file), id: qualifiedId(account.id, id) };
      const exportType = file.mimeType ? DRIVE_EXPORT_TYPES[file.mimeType] : undefined;
      if (exportType === undefined && !isReadableDriveType(file.mimeType)) {
        return {
          file: summary,
          content: null,
          note: "SpecWithCode reads Google Docs, Sheets, Slides and text files. This file type was not read.",
        };
      }
      const content = yield* withToken(account, (token) =>
        exportType !== undefined
          ? api.getText({
              operation: "Drive export",
              url: `${api.endpoints.drive}/files/${id}/export`,
              query: { mimeType: exportType },
              accessToken: token,
              maxBytes: DRIVE_DOWNLOAD_LIMIT_BYTES,
            })
          : api.getText({
              operation: "Drive download",
              url: `${api.endpoints.drive}/files/${id}`,
              query: { alt: "media" },
              accessToken: token,
              maxBytes: DRIVE_DOWNLOAD_LIMIT_BYTES,
            }),
      );
      return { file: summary, content: truncateText(content, DRIVE_TEXT_LIMIT), note: null };
    });

  /**
   * What this project's agents may know: the default account's status and every
   * account it has a granted service on. Accounts it cannot read stay unnamed.
   */
  const projectStatus = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const client = yield* currentClient;
      const tokens = yield* Ref.get(refreshRef);
      const state = yield* Ref.get(stateRef);
      const readable = (accountId: string) =>
        tokens.has(accountId) && projectServices(state, projectId, accountId).length > 0;
      const chosen =
        projectDefaultAccount(state, projectId, readable) ??
        state.accounts.find(
          (account) =>
            tokens.has(account.id) &&
            state.projects.some(
              (entry) => entry.projectId === projectId && entry.account === account.id,
            ),
        ) ??
        state.accounts.find((account) => tokens.has(account.id)) ??
        state.accounts[0];
      const base = projectGoogleStatus({
        clientConfigured: Option.isSome(client),
        connected: chosen !== undefined && tokens.has(chosen.id),
        email: chosen?.email ?? null,
        grantedServices: chosen?.services ?? [],
        projectServices:
          chosen === undefined
            ? []
            : (state.projects.find(
                (entry) => entry.projectId === projectId && entry.account === chosen.id,
              )?.services ?? []),
      });
      const accounts = state.accounts
        .filter((account) => readable(account.id))
        .map((account) => ({
          account: account.email ?? account.id,
          label: account.label ?? null,
          default: account.id === chosen?.id,
          services: projectServices(state, projectId, account.id),
        }));
      return { status: base, accounts, chosen };
    });

  const projectAccess = (
    projectId: ProjectId,
    input?: { readonly checkConnection?: boolean | undefined },
  ) =>
    Effect.gen(function* () {
      const { status: initial, accounts, chosen } = yield* projectStatus(projectId);
      const withAccounts = (result: GoogleProjectStatus): GoogleProjectStatus =>
        accounts.length > 1 ? { ...result, accounts } : result;
      // Status discovery never refreshes tokens or contacts Google by default.
      if (!input?.checkConnection || initial.services.length === 0 || chosen === undefined) {
        return withAccounts(initial);
      }
      const checks = yield* Effect.forEach(initial.services, (service) =>
        requireService(projectId, service, chosen.id).pipe(
          Effect.flatMap((account) =>
            withRawToken(account, (accessToken) =>
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
      const { status: current } = yield* projectStatus(projectId);
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
      return withAccounts({
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
      } satisfies GoogleProjectStatus);
    });

  return GoogleAccountService.of({
    status,
    configureClient,
    startSignIn,
    completeSignIn: (input) => completeSignIn(input).pipe(Effect.map((result) => result.status)),
    callbackPage: renderCallback,
    setProjectAccess,
    setLabel,
    disconnect,
    remove,
    projectAccess,
    gmailSearch,
    gmailRead,
    gmailCreateDraft,
    gmailDraft,
    gmailSendDraft,
    gmailPrepareSend,
    calendarEvents,
    briefingState,
    markBriefingSetUp,
    driveSearch,
    driveRead,
  });
});

export const layer = Layer.effect(GoogleAccountService, make);
