/**
 * Recording a reset announcement an agent read itself (AC-09): the optional
 * routine reads staff and official accounts through the signed-in Chrome tools
 * and records each post here, next to what the feed brings.
 *
 * What an agent passes was read from the web, so it is held to more than the
 * feed: a known provider, a typed kind, a short headline, a post on X by one of
 * that provider's listed accounts or a page on its own site, and an ISO date not
 * ahead of now. A recorded post is marked `origin: "recorded"`: it is listed as
 * unverified and never raises a warning, a notification or a boost, and the
 * verified feed replaces it for the same post.
 *
 * @module resetAnnouncements/recordTool
 */
import type { ResetAnnouncement, ResetAnnouncementKind } from "@specweave-studio/contracts";

import { isoAt } from "../usage/usageLimitHistoryStore.ts";
import { X_HOSTS, canonicalLink, xPost } from "./feeds.ts";

export const RECORD_HEADLINE_MAX = 240;
const LINK_MAX = 2048;
const FUTURE_ALLOWANCE_MS = 5 * 60_000;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/u;

/** The written calendar day exists: no February 31 rolled into March. */
function realDay(date: string): boolean {
  const [year, month, day] = date.slice(0, 10).split("-").map(Number) as [number, number, number];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

interface ProviderSources {
  /** X accounts whose own posts count, lower case without the @. */
  readonly handles: readonly string[];
  /** Hosts of the provider's own pages; `www.` is accepted too. No user-content hosts. */
  readonly hosts: readonly string[];
}

const OPENAI: ProviderSources = {
  handles: ["openai", "openaidevs", "thsottiaux"],
  hosts: ["openai.com", "help.openai.com", "status.openai.com"],
};
const ANTHROPIC: ProviderSources = {
  handles: ["anthropicai", "claudeai"],
  hosts: ["anthropic.com", "support.anthropic.com", "status.anthropic.com", "claude.com"],
};
const META: ProviderSources = { handles: ["aiatmeta"], hosts: ["ai.meta.com"] };

/** The provider names the list and the banner know, with where their own posts live. */
const PROVIDERS: ReadonlyMap<string, ProviderSources> = new Map([
  ["codex", OPENAI],
  ["openai", OPENAI],
  ["claude", ANTHROPIC],
  ["anthropic", ANTHROPIC],
  ["grok", { handles: ["xai"], hosts: ["x.ai"] }],
  ["cursor", { handles: ["cursor_ai"], hosts: ["cursor.com"] }],
  ["muse", META],
  ["meta", META],
]);

export const RECORDABLE_PROVIDERS: readonly string[] = [...PROVIDERS.keys()];
export const RECORDABLE_HANDLES: readonly string[] = [
  ...new Set([...PROVIDERS.values()].flatMap((sources) => sources.handles)),
];
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

/**
 * The post's one canonical link, or why it is refused: an X post becomes
 * `https://x.com/{handle}/status/{id}`, a page loses its query and fragment, so
 * spellings of one post are one announcement.
 */
export function canonicalPostLink(
  raw: string,
  provider: string,
): { link: string } | { refused: string } {
  const sources = PROVIDERS.get(provider);
  if (sources === undefined) return { refused: "Unknown provider." };
  const value = raw.trim();
  if (value.length === 0 || value.length > LINK_MAX) {
    return { refused: "sourceUrl is empty or too long." };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { refused: "sourceUrl is not a link." };
  }
  if (url.protocol !== "https:") return { refused: "sourceUrl must be an https link." };
  if (url.username !== "" || url.password !== "") {
    return { refused: "sourceUrl must not carry a sign-in." };
  }
  if (url.port !== "") return { refused: "sourceUrl must not name a port." };
  const hostname = url.hostname.toLowerCase();
  const post = xPost(url);
  if (post !== null) {
    if (!sources.handles.includes(post.handle)) {
      return {
        refused: `Only posts by ${sources.handles.map((name) => `@${name}`).join(", ")} count for ${provider}.`,
      };
    }
    return { link: canonicalLink(url) };
  }
  if (X_HOSTS.has(hostname)) {
    return { refused: "An X link must be a post: x.com/<account>/status/<id>." };
  }
  const bare = hostname.startsWith("www.") ? hostname.slice(4) : hostname;
  if (!sources.hosts.includes(bare)) {
    return {
      refused: `sourceUrl must be a post on X or a page on ${provider}'s own site (${sources.hosts.join(", ")}).`,
    };
  }
  // The same spelling the feed gives the page, so the feed replaces this recording.
  const link = canonicalLink(url);
  if (new URL(link).pathname === "/") {
    return { refused: "sourceUrl must be the page of the post, not the site's home." };
  }
  return { link };
}

/** The announcement to keep, or why it is refused. The id follows the canonical link. */
export function announcementToRecord(
  input: RecordAnnouncementInput,
  now: number,
): { announcement: ResetAnnouncement } | { refused: string } {
  const provider = input.provider.trim().toLowerCase();
  if (!PROVIDERS.has(provider)) {
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
  const link = canonicalPostLink(input.sourceUrl, provider);
  if ("refused" in link) return link;
  const date = input.publishedAt.trim();
  const published = ISO_DATE_TIME.test(date) && realDay(date) ? Date.parse(date) : Number.NaN;
  if (!Number.isFinite(published)) {
    return { refused: "publishedAt must be an ISO date and time, such as 2026-11-15T06:30:00Z." };
  }
  if (published > now + FUTURE_ALLOWANCE_MS) return { refused: "publishedAt is ahead of now." };
  return {
    announcement: {
      id: `recorded:${link.link}`,
      provider,
      kind: input.kind,
      headline,
      sourceUrl: link.link,
      publishedAt: isoAt(published),
      origin: "recorded",
    } as ResetAnnouncement,
  };
}

export { recordIntoFile } from "./feeds.ts";
