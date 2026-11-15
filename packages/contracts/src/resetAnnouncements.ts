/**
 * Reset announcements: posts in which a provider resets usage limits, grants a
 * banked reset, changes a limit, or promises a reset. Read from a public feed
 * by the main machine and kept once per source link. An announcement is
 * context; the certain signal is the account's own early reset.
 *
 * @module resetAnnouncements
 */
import { Rpc } from "effect/rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * What the post says: limits were reset for everyone, a banked reset was
 * granted, a limit changed, or a reset is promised and has not happened yet.
 */
export const ResetAnnouncementKind = Schema.Literals([
  "full_reset",
  "banked_grant",
  "limit_change",
  "expected_reset",
]);
export type ResetAnnouncementKind = typeof ResetAnnouncementKind.Type;

export const ResetAnnouncement = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The feed's name for the provider: `codex`, `claude`, `grok`. */
  provider: TrimmedNonEmptyString,
  kind: ResetAnnouncementKind,
  headline: TrimmedNonEmptyString,
  /** The post itself; an https link. */
  sourceUrl: TrimmedNonEmptyString,
  publishedAt: IsoDateTime,
});
export type ResetAnnouncement = typeof ResetAnnouncement.Type;

export const ResetAnnouncementsInput = Schema.Struct({});
export type ResetAnnouncementsInput = typeof ResetAnnouncementsInput.Type;

export const ResetAnnouncementsResult = Schema.Struct({
  /** Newest first. */
  announcements: Schema.Array(ResetAnnouncement),
  /** When the feed last answered; absent before the first read and when the feed is off. */
  checkedAt: Schema.optional(IsoDateTime),
  /** False when the person turned the feed off. */
  enabled: Schema.Boolean,
});
export type ResetAnnouncementsResult = typeof ResetAnnouncementsResult.Type;

export const RESET_ANNOUNCEMENT_RPC_METHODS = {
  resetAnnouncementsList: "resetAnnouncements.list",
} as const;

export const resetAnnouncementRpcs = [
  Rpc.make(RESET_ANNOUNCEMENT_RPC_METHODS.resetAnnouncementsList, {
    payload: ResetAnnouncementsInput,
    success: ResetAnnouncementsResult,
    error: EnvironmentAuthorizationError,
  }),
] as const;
