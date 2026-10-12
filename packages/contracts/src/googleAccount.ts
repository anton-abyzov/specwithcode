import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

/**
 * Google account: read-only Gmail, Calendar and Drive for chosen projects.
 *
 * Studio releases ship their own Google OAuth client ("Desktop app" type), so
 * connecting is one click: Google's consent screen opens in the browser and
 * sends the person back to this host. A person or organisation that prefers
 * its own Google Cloud client can still save one, and it replaces Studio's.
 * Studio keeps the refresh token in the host's secret store and never sends
 * it or the client secret back to clients. Only scopes that read are ever
 * requested. A project's agents can use a service only after the person turns
 * it on for that project.
 */

export const GoogleService = Schema.Literals(["gmail", "calendar", "drive"]);
export type GoogleService = typeof GoogleService.Type;

export const GOOGLE_SERVICES: ReadonlyArray<GoogleService> = ["gmail", "calendar", "drive"];

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
});
export type GoogleAccountStatus = typeof GoogleAccountStatus.Type;

export const GoogleAccountConfigureClientInput = Schema.Struct({
  clientId: Schema.String.check(Schema.isPattern(GOOGLE_CLIENT_ID_PATTERN)),
  clientSecret: Schema.String.check(Schema.isPattern(GOOGLE_CLIENT_SECRET_PATTERN)),
});
export type GoogleAccountConfigureClientInput = typeof GoogleAccountConfigureClientInput.Type;

export const GoogleAccountStartSignInInput = Schema.Struct({
  services: Schema.Array(GoogleService).check(Schema.isMinLength(1)),
});
export type GoogleAccountStartSignInInput = typeof GoogleAccountStartSignInInput.Type;

export const GoogleAccountCompleteSignInInput = Schema.Struct({
  /** The address Google redirected to, pasted when the browser could not reach this host. */
  callbackUrl: Schema.String.check(Schema.isMaxLength(4096)),
});
export type GoogleAccountCompleteSignInInput = typeof GoogleAccountCompleteSignInInput.Type;

export const GoogleAccountSetProjectAccessInput = GoogleProjectAccess;
export type GoogleAccountSetProjectAccessInput = typeof GoogleAccountSetProjectAccessInput.Type;

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
