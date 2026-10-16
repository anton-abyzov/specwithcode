/**
 * Pure helpers for the Google account: OAuth URLs and callback parsing, what
 * is kept on disk, and the compact shapes agents receive from Gmail, Calendar
 * and Drive.
 *
 * @module googleAccountLogic
 */
import { GOOGLE_SERVICES, type GoogleService } from "@specweave-studio/contracts";
import * as Schema from "effect/Schema";

/** Read-only scopes; nothing here can send, change or delete. */
export const GOOGLE_SERVICE_SCOPES: Record<GoogleService, string> = {
  gmail: "https://www.googleapis.com/auth/gmail.readonly",
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  drive: "https://www.googleapis.com/auth/drive.readonly",
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
  // A refresh token is only returned with offline access and a fresh consent.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
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

export const GoogleAccountState = Schema.Struct({
  version: Schema.Literal(1),
  email: Schema.NullOr(Schema.String),
  /** The client that obtained the saved refresh token; absent in state saved before it was kept. */
  clientId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  services: Schema.Array(Schema.Literals(["gmail", "calendar", "drive"])),
  projects: Schema.Array(
    Schema.Struct({
      projectId: Schema.String,
      services: Schema.Array(Schema.Literals(["gmail", "calendar", "drive"])),
    }),
  ),
});
export type GoogleAccountState = typeof GoogleAccountState.Type;

export const EMPTY_GOOGLE_ACCOUNT_STATE: GoogleAccountState = {
  version: 1,
  email: null,
  services: [],
  projects: [],
};

/** Replaces one project's services; a project with none is dropped. */
export function withProjectAccess(
  state: GoogleAccountState,
  projectId: string,
  services: ReadonlyArray<GoogleService>,
): GoogleAccountState {
  const others = state.projects.filter((entry) => entry.projectId !== projectId);
  const ordered = orderedServices(services);
  return {
    ...state,
    projects: ordered.length === 0 ? others : [...others, { projectId, services: ordered }],
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
    .map((project) => ({ projectId: project.projectId, services: ordered }));
}

/** What a project may read now: its switches limited to what Google granted. */
export function projectServices(state: GoogleAccountState, projectId: string): GoogleService[] {
  const entry = state.projects.find((candidate) => candidate.projectId === projectId);
  if (!entry) return [];
  const granted = new Set(state.services);
  return entry.services.filter((service) => granted.has(service));
}

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
