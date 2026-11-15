/**
 * Recording a reset announcement an agent read itself (AC-09): the optional
 * routine reads staff and official accounts through the signed-in Chrome tools
 * and records each confirmed post here, next to what the feed brings.
 *
 * What an agent passes is read from the web, so it is held to the feed's rules
 * and more: a known provider, a typed kind, a short headline, an https link to
 * a post on X or the provider's own site, and a date that is not ahead of now.
 *
 * @module resetAnnouncements/recordTool
 */
import type { ResetAnnouncement, ResetAnnouncementKind } from "@specweave-studio/contracts";

import { isoAt } from "../usage/usageLimitHistoryStore.ts";
import { type AnnouncementFile, mergeAnnouncements } from "./feeds.ts";

export const RECORD_HEADLINE_MAX = 240;
const LINK_MAX = 2048;
const FUTURE_ALLOWANCE_MS = 5 * 60_000;

/** Provider names the list and the banner know, each with the hosts its own posts live on. */
const PROVIDER_HOSTS: ReadonlyMap<string, readonly string[]> = new Map([
  ["codex", ["openai.com", "chatgpt.com"]],
  ["openai", ["openai.com", "chatgpt.com"]],
  ["claude", ["anthropic.com", "claude.com", "claude.ai"]],
  ["anthropic", ["anthropic.com", "claude.com", "claude.ai"]],
  ["grok", ["x.ai"]],
  ["cursor", ["cursor.com"]],
  ["muse", ["meta.com", "meta.ai"]],
  ["meta", ["meta.com", "meta.ai"]],
  ["gemini", ["google.com", "blog.google"]],
]);
/** Staff and official accounts post on X; any provider may be linked there. */
const POST_HOSTS = ["x.com", "twitter.com"];

export const RECORDABLE_PROVIDERS: readonly string[] = [...PROVIDER_HOSTS.keys()];
export const RECORDABLE_KINDS: readonly ResetAnnouncementKind[] = [
  "full_reset",
  "banked_grant",
  "limit_change",
  "expected_reset",
];

export interface RecordAnnouncementInput {
  readonly provider: string;
  readonly kind: ResetAnnouncementKind;
  readonly headline: string;
  readonly sourceUrl: string;
  readonly publishedAt: string;
}

const onHost = (hostname: string, host: string) =>
  hostname === host || hostname.endsWith(`.${host}`);

/** Normalized link, or the reason it is refused. */
function postLink(raw: string, provider: string): { link: string } | { refused: string } {
  const value = raw.trim();
  if (value.length === 0 || value.length > LINK_MAX)
    return { refused: "sourceUrl is empty or too long." };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { refused: "sourceUrl is not a link." };
  }
  if (url.protocol !== "https:") return { refused: "sourceUrl must be an https link." };
  if (url.username !== "" || url.password !== "")
    return { refused: "sourceUrl must not carry a sign-in." };
  const hostname = url.hostname.toLowerCase();
  const hosts = [...POST_HOSTS, ...(PROVIDER_HOSTS.get(provider) ?? [])];
  if (!hosts.some((host) => onHost(hostname, host))) {
    return {
      refused: `sourceUrl must be a post on X or ${provider}'s own site (${hosts.join(", ")}).`,
    };
  }
  url.hash = "";
  return { link: url.toString() };
}

/** The announcement to keep, or why it is refused. The id follows the link, so a repeat is one post. */
export function announcementToRecord(
  input: RecordAnnouncementInput,
  now: number,
): { announcement: ResetAnnouncement } | { refused: string } {
  const provider = input.provider.trim().toLowerCase();
  if (!PROVIDER_HOSTS.has(provider)) {
    return { refused: `provider must be one of ${RECORDABLE_PROVIDERS.join(", ")}.` };
  }
  if (!RECORDABLE_KINDS.includes(input.kind)) {
    return { refused: `kind must be one of ${RECORDABLE_KINDS.join(", ")}.` };
  }
  const headline = input.headline.trim().replace(/\s+/gu, " ");
  if (headline === "") return { refused: "headline is empty." };
  if (headline.length > RECORD_HEADLINE_MAX) {
    return { refused: `headline is longer than ${RECORD_HEADLINE_MAX} characters.` };
  }
  const link = postLink(input.sourceUrl, provider);
  if ("refused" in link) return link;
  const published = Date.parse(input.publishedAt);
  if (!Number.isFinite(published)) return { refused: "publishedAt is not a date." };
  if (published > now + FUTURE_ALLOWANCE_MS) return { refused: "publishedAt is ahead of now." };
  return {
    announcement: {
      id: `recorded:${link.link}`.slice(0, 200),
      provider,
      kind: input.kind,
      headline,
      sourceUrl: link.link,
      publishedAt: isoAt(published),
    } as ResetAnnouncement,
  };
}

/**
 * `file` with `announcement` merged in, and whether it was new. A post already
 * known by its link stays as it is, except that a confirmed post replaces a promise.
 */
export function recordIntoFile(
  file: AnnouncementFile,
  announcement: ResetAnnouncement,
  now: number,
): { readonly file: AnnouncementFile; readonly recorded: boolean } {
  const known = file.announcements.find((entry) => entry.sourceUrl === announcement.sourceUrl);
  const replaces =
    known === undefined ||
    (known.kind === "expected_reset" && announcement.kind !== "expected_reset");
  const announcements = mergeAnnouncements(file.announcements, [announcement], now);
  // New or replacing a promise, and still kept within the retention and the cap.
  const recorded = replaces && announcements.includes(announcement);
  return { file: recorded ? { ...file, announcements } : file, recorded };
}
