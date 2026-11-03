/**
 * Pure helpers for the Google account: OAuth URLs and callback parsing, what
 * is kept on disk, and the compact shapes agents receive from Gmail, Calendar
 * and Drive.
 *
 * @module googleAccountLogic
 */
import { GOOGLE_SERVICES, type GoogleService } from "@specweave-studio/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

/**
 * Read-only scopes, plus Gmail compose for reply drafts. Google has no
 * draft-only scope (compose also allows sending a draft), so the no-send rule
 * is Studio's own: it has no send call and no send tool.
 */
export const GOOGLE_SERVICE_SCOPES: Record<GoogleService, string> = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  drive: "https://www.googleapis.com/auth/drive.readonly",
  gmailDrafts: "https://www.googleapis.com/auth/gmail.compose",
};
const IDENTITY_SCOPES = ["openid", "email"];

export const SIGN_IN_TTL_MS = 15 * 60_000;
export const GOOGLE_CALLBACK_PATH = "/api/google/oauth/callback";

export interface GoogleEndpoints {
  readonly authorize: string;
  readonly token: string;
  readonly revoke: string;
  readonly gmail: string;
  readonly calendar: string;
  readonly drive: string;
}

/**
 * Google's hosts, or one test server holding all of them when
 * `STUDIO_GOOGLE_API_URL` is set.
 */
export function googleEndpoints(override: string | undefined): GoogleEndpoints {
  if (override === undefined || override.trim() === "") {
    return {
      authorize: "https://accounts.google.com/o/oauth2/v2/auth",
      token: "https://oauth2.googleapis.com/token",
      revoke: "https://oauth2.googleapis.com/revoke",
      gmail: "https://gmail.googleapis.com/gmail/v1",
      calendar: "https://www.googleapis.com/calendar/v3",
      drive: "https://www.googleapis.com/drive/v3",
    };
  }
  const base = override.trim().replace(/\/+$/u, "");
  return {
    authorize: `${base}/o/oauth2/v2/auth`,
    token: `${base}/token`,
    revoke: `${base}/revoke`,
    gmail: `${base}/gmail/v1`,
    calendar: `${base}/calendar/v3`,
    drive: `${base}/drive/v3`,
  };
}

export const base64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "");

export function buildAuthorizationUrl(input: {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly services: ReadonlyArray<GoogleService>;
  readonly state: string;
  readonly codeChallenge: string;
  /** The address to preselect when reconnecting one saved account. */
  readonly loginHint?: string | null | undefined;
}): string {
  const url = new URL(input.authorizeUrl);
  const scopes = [
    ...IDENTITY_SCOPES,
    ...orderedServices(input.services).map((s) => GOOGLE_SERVICE_SCOPES[s]),
  ];
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // A refresh token is only returned with offline access and a fresh consent. The
  // account chooser lets the person add a second account while signed in to the first.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account consent");
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint);
  return url.toString();
}

export const orderedServices = (services: Iterable<GoogleService>): GoogleService[] => {
  const wanted = new Set(services);
  return GOOGLE_SERVICES.filter((service) => wanted.has(service));
};

/** The services whose scope Google actually granted; the consent screen lets people untick some. */
export function servicesFromScope(scope: string | undefined): GoogleService[] {
  const granted = new Set((scope ?? "").split(/\s+/u));
  return GOOGLE_SERVICES.filter((service) => granted.has(GOOGLE_SERVICE_SCOPES[service]));
}

export type CallbackParams =
  | { readonly type: "code"; readonly code: string; readonly state: string }
  | { readonly type: "error"; readonly error: string; readonly state: string | null }
  | { readonly type: "invalid" };

/** Reads `?code=&state=` (or `?error=`) from the redirect address or just its query. */
export function parseCallback(value: string): CallbackParams {
  let params: URLSearchParams;
  try {
    const trimmed = value.trim();
    params = /^https?:\/\//iu.test(trimmed)
      ? new URL(trimmed).searchParams
      : new URLSearchParams(trimmed.replace(/^[^?]*\?/u, ""));
  } catch {
    return { type: "invalid" };
  }
  const state = params.get("state");
  const error = params.get("error");
  if (error) return { type: "error", error: error.slice(0, 100), state };
  const code = params.get("code");
  if (!code || !state) return { type: "invalid" };
  return { type: "code", code, state };
}

/** The email claim of an ID token straight from Google's token endpoint over TLS. */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: unknown;
    };
    return typeof claims.email === "string" ? claims.email.slice(0, 320) : null;
  } catch {
    return null;
  }
}

/** Human wording for an OAuth error code from the redirect. */
export function describeCallbackError(error: string): string {
  if (error === "access_denied") return "Google sign-in was cancelled.";
  if (error === "admin_policy_enforced") {
    return "Your Google Workspace admin does not allow SpecWithCode. Ask them to allow it, or use your own OAuth client.";
  }
  return `Google sign-in failed: ${error}.`;
}

const ServiceList = Schema.Array(Schema.Literals(["gmail", "calendar", "drive", "gmailDrafts"]));

/** The one-account state saved before several accounts were supported. */
export const GoogleAccountStateV1 = Schema.Struct({
  version: Schema.Literal(1),
  email: Schema.NullOr(Schema.String),
  /** The client that obtained the saved refresh token; absent in state saved before it was kept. */
  clientId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  services: ServiceList,
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      services: ServiceList,
    }),
  ),
  briefingSetUp: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type GoogleAccountStateV1 = typeof GoogleAccountStateV1.Type;

/**
 * The account a host had before several were supported. It keeps the original
 * refresh-token secret and returns bare message and draft ids, so ids agents saw
 * before the update still work.
 */
export const PRIMARY_ACCOUNT_ID = "primary";

export const GoogleStoredAccount = Schema.Struct({
  /** `primary`, or random lowercase hex for every account added after it. */
  id: Schema.String,
  email: Schema.NullOr(Schema.String),
  /** A short name the person gave it, such as "Work". */
  label: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The client that obtained this account's refresh token. */
  clientId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Services Google granted at this account's last sign-in. */
  services: ServiceList,
  /**
   * Personal projects the proactive briefing was already set up for with this account,
   * so a briefing the person deleted is not set up again.
   */
  briefingSetUp: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type GoogleStoredAccount = typeof GoogleStoredAccount.Type;

export const GoogleAccountState = Schema.Struct({
  version: Schema.Literal(2),
  /** In the order they were connected; the first is where older clients' calls go. */
  accounts: Schema.Array(GoogleStoredAccount),
  /** Which services of which account each project's agents may read. */
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      account: Schema.String,
      services: ServiceList,
    }),
  ),
  /** The account a project's agents use when they name none. */
  defaults: Schema.optionalKey(
    Schema.Array(Schema.Struct({ projectId: Schema.String, account: Schema.String })),
  ),
});
export type GoogleAccountState = typeof GoogleAccountState.Type;

export const EMPTY_GOOGLE_ACCOUNT_STATE: GoogleAccountState = {
  version: 2,
  accounts: [],
  projects: [],
};

const decodeV2 = Schema.decodeUnknownExit(Schema.fromJsonString(GoogleAccountState));
const decodeV1 = Schema.decodeUnknownExit(Schema.fromJsonString(GoogleAccountStateV1));

/**
 * Saved state in either version. One saved account becomes the primary account
 * with every switch it had. `hasPrimaryToken` keeps a sign-in whose address
 * Google did not return.
 */
export function readGoogleAccountState(
  json: string | null,
  hasPrimaryToken: boolean,
): GoogleAccountState {
  if (json !== null) {
    const v2 = decodeV2(json);
    if (Exit.isSuccess(v2)) return v2.value;
    const v1 = decodeV1(json);
    if (Exit.isSuccess(v1)) return migrateGoogleAccountState(v1.value, hasPrimaryToken);
  }
  return hasPrimaryToken
    ? {
        ...EMPTY_GOOGLE_ACCOUNT_STATE,
        accounts: [{ id: PRIMARY_ACCOUNT_ID, email: null, services: [] }],
      }
    : EMPTY_GOOGLE_ACCOUNT_STATE;
}

export function migrateGoogleAccountState(
  v1: GoogleAccountStateV1,
  hasPrimaryToken: boolean,
): GoogleAccountState {
  const used =
    hasPrimaryToken ||
    v1.email !== null ||
    v1.services.length > 0 ||
    v1.projects.length > 0 ||
    (v1.briefingSetUp?.length ?? 0) > 0;
  if (!used) return EMPTY_GOOGLE_ACCOUNT_STATE;
  return {
    version: 2,
    accounts: [
      {
        id: PRIMARY_ACCOUNT_ID,
        email: v1.email,
        ...(v1.clientId === undefined ? {} : { clientId: v1.clientId }),
        services: v1.services,
        ...(v1.briefingSetUp === undefined ? {} : { briefingSetUp: v1.briefingSetUp }),
      },
    ],
    projects: v1.projects.map((entry) => ({
      projectId: entry.projectId,
      account: PRIMARY_ACCOUNT_ID,
      services: entry.services,
    })),
  };
}

const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  a != null && b != null && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The saved account a new sign-in belongs to: the account Reconnect named, else the same
 * address. With nothing else saved, the one disconnected account Google never named is
 * reused, as a single-account host always did; with several, an unnamed sign-in is a new
 * account so it never inherits another account's project switches.
 */
export function accountForSignIn(
  state: GoogleAccountState,
  email: string | null,
  connected: ReadonlySet<string>,
  target: string | null = null,
): GoogleStoredAccount | undefined {
  const named =
    target === null ? undefined : state.accounts.find((account) => account.id === target);
  if (
    named !== undefined &&
    (named.email === null || email === null || sameAddress(named.email, email))
  ) {
    return named;
  }
  const same = state.accounts.find((account) => sameAddress(account.email, email));
  if (same) return same;
  const only = state.accounts.length === 1 ? state.accounts[0] : undefined;
  return only !== undefined && only.email === null && !connected.has(only.id) ? only : undefined;
}

/** Replaces one project's services for one account; an entry with none is dropped. */
export function withProjectAccess(
  state: GoogleAccountState,
  projectId: string,
  accountId: string,
  services: ReadonlyArray<GoogleService>,
): GoogleAccountState {
  const others = state.projects.filter(
    (entry) => !(entry.projectId === projectId && entry.account === accountId),
  );
  const ordered = orderedServices(services);
  return {
    ...state,
    projects:
      ordered.length === 0
        ? others
        : [...others, { projectId, account: accountId, services: ordered }],
  };
}

/** Sets the account a project uses when its agents name none. */
export function withProjectDefault(
  state: GoogleAccountState,
  projectId: string,
  accountId: string,
): GoogleAccountState {
  const others = (state.defaults ?? []).filter((entry) => entry.projectId !== projectId);
  return { ...state, defaults: [...others, { projectId, account: accountId }] };
}

/** Forgets one account with its switches and defaults. */
export function withoutAccount(state: GoogleAccountState, accountId: string): GoogleAccountState {
  return {
    ...state,
    accounts: state.accounts.filter((account) => account.id !== accountId),
    projects: state.projects.filter((entry) => entry.account !== accountId),
    defaults: (state.defaults ?? []).filter((entry) => entry.account !== accountId),
  };
}

/**
 * The switches a newly connected account starts with: every granted service for each
 * live personal project, nothing anywhere else. Reading someone's mail is opt-in.
 */
export function personalProjectAccess(
  projects: ReadonlyArray<{
    readonly projectId: string;
    readonly deletedAt: string | null;
    readonly workspaceSettings?:
      | { readonly kind?: string | undefined; readonly archived?: boolean | undefined }
      | null
      | undefined;
  }>,
  accountId: string,
  services: ReadonlyArray<GoogleService>,
): GoogleAccountState["projects"] {
  const ordered = orderedServices(services);
  if (ordered.length === 0) return [];
  return projects
    .filter(
      (project) =>
        project.deletedAt === null &&
        project.workspaceSettings?.kind === "personal" &&
        project.workspaceSettings.archived !== true,
    )
    .map((project) => ({ projectId: project.projectId, account: accountId, services: ordered }));
}

/** What a project may read now with one account: its switches limited to what Google granted. */
export function projectServices(
  state: GoogleAccountState,
  projectId: string,
  accountId: string,
): GoogleService[] {
  const entry = state.projects.find(
    (candidate) => candidate.projectId === projectId && candidate.account === accountId,
  );
  const account = state.accounts.find((candidate) => candidate.id === accountId);
  if (!entry || !account) return [];
  const granted = new Set(account.services);
  return entry.services.filter((service) => granted.has(service));
}

/** The account a project uses when its agents name none: its chosen one, else the first it may read. */
export function projectDefaultAccount(
  state: GoogleAccountState,
  projectId: string,
  usable: (accountId: string) => boolean,
): GoogleStoredAccount | undefined {
  const chosen = state.defaults?.find((entry) => entry.projectId === projectId)?.account;
  const candidates = state.accounts.filter((account) => usable(account.id));
  return candidates.find((account) => account.id === chosen) ?? candidates[0];
}

/** How an agent may name an account: its address, its label, or its id. */
export function matchAccount(
  accounts: ReadonlyArray<GoogleStoredAccount>,
  name: string,
): GoogleStoredAccount | undefined {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return undefined;
  return (
    accounts.find((account) => sameAddress(account.email, wanted)) ??
    accounts.find((account) => account.id === wanted) ??
    accounts.find((account) => (account.label ?? "").trim().toLowerCase() === wanted)
  );
}

/** What agents call an account: its label and address when both are known. */
export const accountName = (account: GoogleStoredAccount): string =>
  account.label && account.email
    ? `${account.label} (${account.email})`
    : (account.email ?? account.label ?? "the Google account");

/**
 * Ids agents receive carry their account, so a read or reply always reaches the
 * mailbox the message came from. The primary account's ids stay bare.
 */
export const qualifiedId = (accountId: string, id: string): string =>
  accountId === PRIMARY_ACCOUNT_ID ? id : `${accountId}:${id}`;

export function splitQualifiedId(value: string): { readonly account: string; readonly id: string } {
  const at = value.indexOf(":");
  return at === -1
    ? { account: PRIMARY_ACCOUNT_ID, id: value }
    : { account: value.slice(0, at), id: value.slice(at + 1) };
}

export const ACCOUNT_ID_PATTERN = /^(primary|[0-9a-f]{12})$/u;
export const MAX_GOOGLE_ACCOUNTS = 10;
export const ACCOUNT_LABEL_LIMIT = 40;

// --- Shapes agents receive -------------------------------------------------

export const truncateText = (text: string, limit: number): string =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n[Truncated by SpecWithCode at ${limit} characters.]`;

interface GmailHeader {
  readonly name?: string;
  readonly value?: string;
}
export interface GmailPart {
  readonly mimeType?: string;
  readonly filename?: string;
  readonly headers?: ReadonlyArray<GmailHeader>;
  readonly body?: { readonly data?: string; readonly size?: number };
  readonly parts?: ReadonlyArray<GmailPart>;
}
export interface GmailMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly snippet?: string;
  readonly labelIds?: ReadonlyArray<string>;
  readonly internalDate?: string;
  readonly payload?: GmailPart;
}

const header = (part: GmailPart | undefined, name: string): string | null => {
  const match = part?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return match?.value ?? null;
};

export function summarizeGmailMessage(message: GmailMessage) {
  return {
    id: message.id,
    threadId: message.threadId ?? null,
    from: header(message.payload, "From"),
    to: header(message.payload, "To"),
    subject: header(message.payload, "Subject"),
    date: header(message.payload, "Date"),
    snippet: decodeEntities(message.snippet ?? ""),
    unread: message.labelIds?.includes("UNREAD") ?? false,
    labels: [...(message.labelIds ?? [])],
  };
}

const decodePartData = (data: string | undefined): string =>
  data ? Buffer.from(data, "base64url").toString("utf8") : "";

/** Turns an HTML mail body into readable text. Good enough for summaries, not for rendering. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/giu, "")
      .replace(/<br\s*\/?>/giu, "\n")
      .replace(/<\/(p|div|tr|li|h[1-6])>/giu, "\n")
      .replace(/<[^>]+>/gu, ""),
  )
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gu, " ")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&#x27;/gu, "'")
    .replace(/&amp;/gu, "&");
}

function collectParts(part: GmailPart | undefined, out: GmailPart[]): GmailPart[] {
  if (!part) return out;
  out.push(part);
  for (const child of part.parts ?? []) collectParts(child, out);
  return out;
}

export const GMAIL_BODY_LIMIT = 20_000;

export function readGmailMessage(message: GmailMessage) {
  const parts = collectParts(message.payload, []);
  const plain = parts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  const html = parts.find((p) => p.mimeType === "text/html" && p.body?.data);
  const body = plain
    ? decodePartData(plain.body?.data)
    : html
      ? htmlToText(decodePartData(html.body?.data))
      : "";
  return {
    ...summarizeGmailMessage(message),
    body: truncateText(body.trim(), GMAIL_BODY_LIMIT),
    attachments: parts
      .filter((p) => p.filename)
      .map((p) => ({
        filename: p.filename ?? "",
        mimeType: p.mimeType ?? null,
        size: p.body?.size ?? null,
      })),
  };
}

/** A saved draft as the person will see it on the card that asks to send it. */
export function readGmailDraft(draft: { readonly id?: string; readonly message?: GmailMessage }): {
  readonly draftId: string;
  readonly messageId: string | null;
  readonly threadId: string | null;
  readonly to: string | null;
  readonly subject: string | null;
  readonly body: string;
} | null {
  if (typeof draft.id !== "string" || draft.message === undefined) return null;
  const message = readGmailMessage(draft.message);
  return {
    draftId: draft.id,
    messageId: message.id ?? null,
    threadId: message.threadId,
    to: message.to,
    subject: message.subject,
    body: message.body,
  };
}

/** Longest reply body an agent may save as a draft. */
export const GMAIL_DRAFT_BODY_LIMIT = 10_000;

/** A header value with line breaks removed, so it cannot add headers of its own. */
const headerValue = (value: string): string => value.replace(/[\r\n]+/gu, " ").trim();

/** RFC 2047 encoding for a header that is not plain ASCII. */
const encodedWord = (value: string): string =>
  /^[\x20-\x7e]*$/u.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;

const addressOf = (value: string): string =>
  (/<([^>]+)>/u.exec(value)?.[1] ?? value).trim().toLowerCase();

export interface GmailReplyDraft {
  readonly to: string;
  readonly subject: string;
  /** The RFC 2822 message, base64url, as Gmail's drafts.create takes it. */
  readonly raw: string;
}

/**
 * A plain-text reply to `message`, threaded under it. It goes to Reply-To or
 * the sender; when the person sent the original themselves, back to its
 * recipients. Null when the original names nobody to reply to.
 */
export function buildGmailReplyDraft(input: {
  readonly message: GmailMessage;
  readonly body: string;
  readonly selfEmail: string | null;
}): GmailReplyDraft | null {
  const part = input.message.payload;
  const from = header(part, "From");
  const fromSelf =
    from !== null && input.selfEmail !== null && addressOf(from) === input.selfEmail.toLowerCase();
  const to = headerValue(
    (fromSelf ? header(part, "To") : null) ?? header(part, "Reply-To") ?? from ?? "",
  );
  if (to === "") return null;
  const original = headerValue(header(part, "Subject") ?? "");
  const subject = /^re:/iu.test(original) ? original : `Re: ${original}`.trim();
  const messageId = header(part, "Message-ID") ?? header(part, "Message-Id");
  const references = [header(part, "References"), messageId]
    .filter((value): value is string => value !== null && value.trim() !== "")
    .map(headerValue)
    .join(" ");
  const lines = [
    `To: ${to}`,
    `Subject: ${encodedWord(subject)}`,
    ...(messageId ? [`In-Reply-To: ${headerValue(messageId)}`] : []),
    ...(references ? [`References: ${references}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body.replace(/\r?\n/gu, "\r\n"), "utf8")
      .toString("base64")
      .replace(/(.{76})/gu, "$1\r\n"),
  ];
  return { to, subject, raw: Buffer.from(lines.join("\r\n"), "utf8").toString("base64url") };
}

/** Where the person opens a saved draft in Gmail on the web. */
export const gmailDraftLink = (messageId: string): string =>
  `https://mail.google.com/mail/#drafts?compose=${encodeURIComponent(messageId)}`;

export interface CalendarEvent {
  readonly id: string;
  readonly status?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly htmlLink?: string;
  readonly start?: { readonly dateTime?: string; readonly date?: string };
  readonly end?: { readonly dateTime?: string; readonly date?: string };
  readonly organizer?: { readonly email?: string; readonly displayName?: string };
  readonly attendees?: ReadonlyArray<{
    readonly email?: string;
    readonly displayName?: string;
    readonly responseStatus?: string;
    readonly self?: boolean;
  }>;
  readonly hangoutLink?: string;
}

export function summarizeCalendarEvent(event: CalendarEvent) {
  const self = event.attendees?.find((attendee) => attendee.self);
  return {
    id: event.id,
    title: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    allDay: event.start?.date !== undefined && event.start.dateTime === undefined,
    location: event.location ?? null,
    meetingLink: event.hangoutLink ?? null,
    organizer: event.organizer?.displayName ?? event.organizer?.email ?? null,
    myResponse: self?.responseStatus ?? null,
    attendees: (event.attendees ?? []).slice(0, 30).map((a) => a.displayName ?? a.email ?? ""),
    description: event.description ? truncateText(htmlToText(event.description), 2_000) : null,
    link: event.htmlLink ?? null,
  };
}

export interface DriveFile {
  readonly id: string;
  readonly name?: string;
  readonly mimeType?: string;
  readonly modifiedTime?: string;
  readonly webViewLink?: string;
  readonly size?: string;
  readonly owners?: ReadonlyArray<{
    readonly displayName?: string;
    readonly emailAddress?: string;
  }>;
}

export function summarizeDriveFile(file: DriveFile) {
  return {
    id: file.id,
    name: file.name ?? "",
    mimeType: file.mimeType ?? null,
    modifiedTime: file.modifiedTime ?? null,
    owner: file.owners?.[0]?.displayName ?? file.owners?.[0]?.emailAddress ?? null,
    link: file.webViewLink ?? null,
  };
}

export const DRIVE_FILE_FIELDS =
  "id,name,mimeType,modifiedTime,webViewLink,size,owners(displayName,emailAddress)";
export const DRIVE_TEXT_LIMIT = 50_000;
export const DRIVE_DOWNLOAD_LIMIT_BYTES = 2_000_000;

/** Google editor files are exported; these are the text formats used. */
export const DRIVE_EXPORT_TYPES: Record<string, string> = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};

export function isReadableDriveType(mimeType: string | undefined): boolean {
  if (!mimeType) return false;
  return (
    mimeType.startsWith("text/") ||
    ["application/json", "application/xml", "application/x-yaml", "application/yaml"].includes(
      mimeType,
    )
  );
}

const escapeDriveString = (value: string) => value.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'");

/** Builds a Drive `q` from plain words, so agents never write Drive's query language. */
export function driveQuery(input: {
  readonly text?: string;
  readonly modifiedAfter?: string;
}): string {
  const clauses = ["trashed = false"];
  const text = input.text?.trim();
  if (text) clauses.push(`fullText contains '${escapeDriveString(text.slice(0, 200))}'`);
  if (input.modifiedAfter)
    clauses.push(`modifiedTime > '${escapeDriveString(input.modifiedAfter)}'`);
  return clauses.join(" and ");
}

/** The page the browser lands on after Google redirects back to this host. */
export function callbackPage(input: { readonly ok: boolean; readonly message: string }): string {
  const title = input.ok ? "Google account connected" : "Google sign-in did not finish";
  const escaped = input.message
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#1f2328;background:#fff}@media(prefers-color-scheme:dark){body{color:#e6edf3;background:#0d1117}}h1{font-size:1.25rem}</style></head><body><h1>${title}</h1><p>${escaped}</p></body></html>`;
}
