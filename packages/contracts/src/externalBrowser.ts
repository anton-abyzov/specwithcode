/**
 * External browsers - sending a page to a browser installed on the machine,
 * in a chosen profile.
 *
 * Chromium-family browsers keep each signed-in identity in its own profile
 * directory ("Default", "Profile 2"). Opening a URL with that directory lets a
 * user keep, say, the Chrome profile signed in to a Google Ads account for
 * Google Ads pages, without the in-app browser needing those sessions.
 *
 * Ids and directories are plain strings in settings so a value written by a
 * newer build still decodes in an older one; the desktop shell checks both
 * against what it actually finds on disk before launching anything.
 *
 * @module ExternalBrowser
 */
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Browsers the desktop shell knows how to launch with a profile. */
export const EXTERNAL_BROWSER_IDS = ["chrome", "edge", "brave", "vivaldi", "helium"] as const;
export type ExternalBrowserId = (typeof EXTERNAL_BROWSER_IDS)[number];

/** Names for known ids, used before (or without) the installed list. */
const EXTERNAL_BROWSER_NAMES: Readonly<Record<string, string>> = {
  chrome: "Chrome",
  edge: "Microsoft Edge",
  brave: "Brave",
  vivaldi: "Vivaldi",
  helium: "Helium",
};

export const ExternalBrowserProfile = Schema.Struct({
  /** Directory name under the browser's user-data dir, e.g. "Profile 2". */
  directory: TrimmedNonEmptyString,
  /** The name the browser shows for it, e.g. "Work". */
  name: TrimmedNonEmptyString,
  /** The account signed in to the profile, when the browser records one. */
  account: Schema.optional(TrimmedNonEmptyString),
});
export type ExternalBrowserProfile = typeof ExternalBrowserProfile.Type;

export const ExternalBrowser = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  /** Empty when the browser is installed but has never been opened. */
  profiles: Schema.Array(ExternalBrowserProfile),
});
export type ExternalBrowser = typeof ExternalBrowser.Type;

/** A browser and, optionally, one of its profiles. */
export const ExternalBrowserTarget = Schema.Struct({
  browserId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  profileDirectory: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
});
export type ExternalBrowserTarget = typeof ExternalBrowserTarget.Type;

export const OpenInExternalBrowserInput = Schema.Struct({
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(32_768)),
  target: ExternalBrowserTarget,
});
export type OpenInExternalBrowserInput = typeof OpenInExternalBrowserInput.Type;

/**
 * "Chrome — Work", or just "Chrome" without a profile. The profile's folder
 * ("Profile 2") is added only when two profiles of the browser share a name.
 */
export function externalBrowserTargetLabel(
  browsers: ReadonlyArray<ExternalBrowser>,
  target: ExternalBrowserTarget,
): string {
  const browser = browsers.find((candidate) => candidate.id === target.browserId);
  const browserName = browser?.name ?? EXTERNAL_BROWSER_NAMES[target.browserId] ?? target.browserId;
  if (target.profileDirectory === undefined) return browserName;
  const profile = browser?.profiles.find(
    (candidate) => candidate.directory === target.profileDirectory,
  );
  if (!profile) return `${browserName} — ${target.profileDirectory}`;
  const shared = browser!.profiles.some(
    (other) => other.directory !== profile.directory && other.name === profile.name,
  );
  return shared && profile.name !== profile.directory
    ? `${browserName} — ${profile.name} (${profile.directory})`
    : `${browserName} — ${profile.name}`;
}
