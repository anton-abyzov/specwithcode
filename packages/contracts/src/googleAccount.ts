import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

/**
 * Google accounts: Gmail, Calendar and Drive for chosen projects. A host can
 * keep several Google accounts; each has its own sign-in, services and project
 * switches, and a project names the account its agents use by default. Every service
 * reads only, except Gmail drafts, which saves reply drafts for the person to
 * review and send; nothing in Studio can send mail.
 *
 * Studio releases ship their own Google OAuth client ("Desktop app" type), so
 * connecting is one click: Google's consent screen opens in the browser and
 * sends the person back to this host. A person or organisation that prefers
 * its own Google Cloud client can still save one, and it replaces Studio's.
 * Studio keeps the refresh token in the host's secret store and never sends
 * it or the client secret back to clients. Only scopes that read are
 * requested, plus Gmail's compose scope when the person ticks Gmail drafts. A
 * project's agents can use a service only after the person turns
 * it on for that project.
 */

export const GoogleService = Schema.Literals(["gmail", "calendar", "drive", "gmailDrafts"]);
export type GoogleService = typeof GoogleService.Type;

export const GOOGLE_SERVICES: ReadonlyArray<GoogleService> = [
  "gmail",
  "calendar",
  "drive",
  "gmailDrafts",
];

/** Services a new sign-in asks for unless the person ticks more: the read-only ones. */
export const GOOGLE_READ_SERVICES: ReadonlyArray<GoogleService> = ["gmail", "calendar", "drive"];

/** Desktop-app client ids look like `1234-abc.apps.googleusercontent.com`. */
export const GOOGLE_CLIENT_ID_PATTERN =
  /^[0-9]{6,30}-[a-z0-9]{8,64}\.apps\.googleusercontent\.com$/u;

/** Client secrets are short opaque strings, usually `GOCSPX-...`. */
export const GOOGLE_CLIENT_SECRET_PATTERN = /^[A-Za-z0-9_-]{16,80}$/u;

/** Which OAuth client sign-in uses: the one shipped with Studio, or the person's own. */
export const GoogleClientSource = Schema.Literals(["studio", "own"]);
export type GoogleClientSource = typeof GoogleClientSource.Type;

export const GoogleProjectAccess = Schema.Struct({
  projectId: ProjectId,
  services: Schema.Array(GoogleService),
});
export type GoogleProjectAccess = typeof GoogleProjectAccess.Type;

/** One saved Google account. */
export const GoogleConnectedAccount = Schema.Struct({
  /** Stable id: `primary` for the account a host had first, else random hex. */
  id: Schema.String,
  email: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  /** Its refresh token is saved and was accepted the last time it was used. */
  connected: Schema.Boolean,
  services: Schema.Array(GoogleService),
  projects: Schema.Array(GoogleProjectAccess),
  lastError: Schema.NullOr(Schema.String),
});
export type GoogleConnectedAccount = typeof GoogleConnectedAccount.Type;

export const GoogleProjectDefaultAccount = Schema.Struct({
  projectId: ProjectId,
  account: Schema.String,
});
export type GoogleProjectDefaultAccount = typeof GoogleProjectDefaultAccount.Type;

/** Most Google accounts one host keeps. */
export const GOOGLE_MAX_ACCOUNTS = 10;
export const GOOGLE_ACCOUNT_LABEL_MAX = 40;

/**
 * The top-level `connected`, `email`, `services` and `projects` describe the
 * first account, as they did when a host kept only one; `accounts` lists them all.
 */
export const GoogleAccountStatus = Schema.Struct({
  /** Sign-in can start: Studio ships a client, or the person saved their own. */
  clientConfigured: Schema.Boolean,
  /** The person's own client id; it is not a secret and helps them recognise it. */
  clientId: Schema.NullOr(Schema.String),
  /**
   * The client sign-in uses. Absent from services that predate Studio's own
   * client, where any configured client is the person's own.
   */
  clientSource: Schema.optionalKey(Schema.NullOr(GoogleClientSource)),
  /** A refresh token is saved and was accepted the last time it was used. */
  connected: Schema.Boolean,
  email: Schema.NullOr(Schema.String),
  /** Services Google granted at sign-in. The person may untick some on the consent screen. */
  services: Schema.Array(GoogleService),
  /** Which granted services each project's agents may read. */
  projects: Schema.Array(GoogleProjectAccess),
  /** A sign-in in progress: open `authorizationUrl` in a browser. */
  signIn: Schema.NullOr(
    Schema.Struct({
      authorizationUrl: Schema.String,
      redirectUri: Schema.String,
      expiresAt: Schema.String,
    }),
  ),
  /** The last failure talking to Google, without request contents. */
  lastError: Schema.NullOr(Schema.String),
  /** Every saved account, in the order they were connected. Absent from older servers. */
  accounts: Schema.optionalKey(Schema.Array(GoogleConnectedAccount)),
  /** The account each project uses when its agents name none. */
  defaults: Schema.optionalKey(Schema.Array(GoogleProjectDefaultAccount)),
});
export type GoogleAccountStatus = typeof GoogleAccountStatus.Type;

export const GoogleAccountConfigureClientInput = Schema.Struct({
  clientId: Schema.String.check(Schema.isPattern(GOOGLE_CLIENT_ID_PATTERN)),
  clientSecret: Schema.String.check(Schema.isPattern(GOOGLE_CLIENT_SECRET_PATTERN)),
});
export type GoogleAccountConfigureClientInput = typeof GoogleAccountConfigureClientInput.Type;

export const GoogleAccountStartSignInInput = Schema.Struct({
  services: Schema.Array(GoogleService).check(Schema.isMinLength(1)),
  /**
   * Reconnect this saved account (its id); Google preselects its address.
   * Without it, whichever account the person picks is added, or reconnected when saved.
   */
  account: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
});
export type GoogleAccountStartSignInInput = typeof GoogleAccountStartSignInInput.Type;

export const GoogleAccountCompleteSignInInput = Schema.Struct({
  /** The address Google redirected to, pasted when the browser could not reach this host. */
  callbackUrl: Schema.String.check(Schema.isMaxLength(4096)),
});
export type GoogleAccountCompleteSignInInput = typeof GoogleAccountCompleteSignInInput.Type;

export const GoogleAccountSetProjectAccessInput = Schema.Struct({
  ...GoogleProjectAccess.fields,
  /** The account these switches are for, by id; the first account when absent. */
  account: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** Also make it the project's default account. */
  makeDefault: Schema.optionalKey(Schema.Boolean),
});
export type GoogleAccountSetProjectAccessInput = typeof GoogleAccountSetProjectAccessInput.Type;

export const GoogleAccountDisconnectInput = Schema.Struct({
  /** One account by id; every account when absent, as older clients expect. */
  account: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** Also forget the account with its project switches, instead of keeping them for the next sign-in. */
  forget: Schema.optionalKey(Schema.Boolean),
});
export type GoogleAccountDisconnectInput = typeof GoogleAccountDisconnectInput.Type;

export const GoogleAccountSetLabelInput = Schema.Struct({
  account: Schema.String.check(Schema.isMaxLength(64)),
  /** A short name such as "Work"; null clears it. */
  label: Schema.NullOr(Schema.String.check(Schema.isMaxLength(GOOGLE_ACCOUNT_LABEL_MAX))),
});
export type GoogleAccountSetLabelInput = typeof GoogleAccountSetLabelInput.Type;

export class GoogleAccountError extends Schema.TaggedError<GoogleAccountError>()(
  "GoogleAccountError",
  {
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
