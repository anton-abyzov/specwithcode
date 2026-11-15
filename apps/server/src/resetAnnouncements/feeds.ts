/**
 * The public feeds reset announcements are read from, and how their items
 * become announcements. Pure apart from `fetchFeed`, so the parsing and the
 * merge are tested without a network.
 *
 * A feed is untrusted text: only verified items with an https source link are
 * kept, text is cut to a length, and nothing in it is ever followed or run.
 *
 * @module resetAnnouncements/feeds
 */
import type { ResetAnnouncement, ResetAnnouncementKind } from "@specweave-studio/contracts";

import { isoAt } from "../usage/usageLimitHistoryStore.ts";

/** Confirmed events: limits reset, banked resets granted, limits changed. */
export const CONFIRMED_FEED_URL = "https://airesets.dev/alert-feed.json";
/** Promises by a named source that a reset is coming. */
export const PROMISED_FEED_URL = "https://airesets.dev/wire-fallback.json";

const FEED_TIMEOUT_MS = 10_000;
const FEED_MAX_BYTES = 1_000_000;
const HEADLINE_MAX = 240;
/** Announcements are news; older ones leave the list. */
export const ANNOUNCEMENT_RETENTION_MS = 180 * 24 * 60 * 60_000;
export const ANNOUNCEMENT_MAX = 200;

export type FeedReading =
  | { readonly state: "fresh"; readonly text: string; readonly etag: string | null }
  | { readonly state: "unchanged" }
  | { readonly state: "failed" };

/** The body as text, or null once it passes the cap: it is never held whole first. */
async function readCapped(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > FEED_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

/** GET `url`, conditional on the `etag` of the last read. Never throws. */
export async function fetchFeed(
  url: string,
  etag: string | null,
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): Promise<FeedReading> {
  try {
    const response = await fetcher(url, {
      headers: {
        accept: "application/json",
        ...(etag === null ? {} : { "if-none-match": etag }),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (response.status === 304) return { state: "unchanged" };
    // A redirect is never followed: the feed has one address, and a hijacked answer must
    // not send this machine's request anywhere else.
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { state: "failed" };
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > FEED_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return { state: "failed" };
    }
    const text = await readCapped(response);
    return text === null
      ? { state: "failed" }
      : { state: "fresh", text, etag: response.headers.get("etag") };
  } catch {
    return { state: "failed" };
  }
}

type FeedKinds = ReadonlyMap<string, ResetAnnouncementKind>;
// Maps, not object literals: a feed's `kind` of "toString" must not find a prototype.
const CONFIRMED_KINDS: FeedKinds = new Map([
  ["hard-reset", "full_reset"],
  ["banked-reset", "banked_grant"],
  ["boost", "limit_change"],
]);
const PROMISED_KINDS: FeedKinds = new Map([["reset-untyped", "expected_reset"]]);
const LINK_MAX = 2048;
/** A post dated later than this past the read is a wrong clock or a forgery. */
const FUTURE_ALLOWANCE_MS = 5 * 60_000;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const httpsLink = (value: unknown): string | null => {
  const link = text(value);
  if (link === null || link.length > LINK_MAX) return null;
  try {
    return new URL(link).protocol === "https:" ? link : null;
  } catch {
    return null;
  }
};

/** The items of one feed that are verified, typed and linked; anything else is dropped. */
export function parseFeed(raw: string, kinds: FeedKinds, now: number): ResetAnnouncement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const items = (parsed as { readonly items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: Record<string, unknown> | null): ResetAnnouncement[] => {
    if (item === null || typeof item !== "object" || item.evidence !== "verified") return [];
    const kind = typeof item.kind === "string" ? kinds.get(item.kind) : undefined;
    const id = text(item.id);
    const provider = text(item.provider);
    const headline = text(item.headline);
    const sourceUrl = httpsLink(item.sourceUrl);
    const published = Date.parse(text(item.publishedAt) ?? "");
    if (
      kind === undefined ||
      id === null ||
      provider === null ||
      headline === null ||
      sourceUrl === null ||
      !Number.isFinite(published) ||
      published > now + FUTURE_ALLOWANCE_MS
    ) {
      return [];
    }
    return [
      {
        id: id.slice(0, 200),
        provider: provider.toLowerCase().slice(0, 40),
        kind,
        headline: headline.slice(0, HEADLINE_MAX),
        sourceUrl,
        publishedAt: isoAt(published),
      } as ResetAnnouncement,
    ];
  });
}

export const parseConfirmedFeed = (raw: string, now: number) =>
  parseFeed(raw, CONFIRMED_KINDS, now);
export const parsePromisedFeed = (raw: string, now: number) => parseFeed(raw, PROMISED_KINDS, now);

/**
 * `known` with `read` added: one announcement per source link, a confirmed
 * event replacing a promise for the same post, newest first, within the
 * retention and the cap.
 */
export function mergeAnnouncements(
  known: readonly ResetAnnouncement[],
  read: readonly ResetAnnouncement[],
  now: number,
): ResetAnnouncement[] {
  const byLink = new Map<string, ResetAnnouncement>();
  for (const announcement of [...known, ...read]) {
    const seen = byLink.get(announcement.sourceUrl);
    if (seen === undefined || (seen.kind === "expected_reset" && announcement.kind !== "expected_reset")) {
      byLink.set(announcement.sourceUrl, announcement);
    }
  }
  return [...byLink.values()]
    .filter((announcement) => {
      const published = Date.parse(announcement.publishedAt);
      // Also for what an earlier read saved: a post dated ahead of now is never listed.
      return (
        published <= now + FUTURE_ALLOWANCE_MS && now - published <= ANNOUNCEMENT_RETENTION_MS
      );
    })
    .toSorted(
      (left, right) =>
        Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
        left.id.localeCompare(right.id),
    )
    .slice(0, ANNOUNCEMENT_MAX);
}

export interface AnnouncementFile {
  readonly announcements: readonly ResetAnnouncement[];
  readonly checkedAt: number | null;
  readonly etags: { readonly confirmed: string | null; readonly promised: string | null };
}

export const EMPTY_ANNOUNCEMENT_FILE: AnnouncementFile = {
  announcements: [],
  checkedAt: null,
  etags: { confirmed: null, promised: null },
};

/** The saved file, tolerant of anything: a file it cannot read is an empty one. */
export function decodeAnnouncementFile(raw: string): AnnouncementFile {
  try {
    const parsed = JSON.parse(raw) as Partial<AnnouncementFile> | null;
    const announcements = Array.isArray(parsed?.announcements)
      ? parsed.announcements.filter(
          (entry): entry is ResetAnnouncement =>
            typeof entry?.id === "string" &&
            typeof entry.provider === "string" &&
            typeof entry.headline === "string" &&
            httpsLink(entry.sourceUrl) !== null &&
            Number.isFinite(Date.parse(entry.publishedAt)) &&
            ["full_reset", "banked_grant", "limit_change", "expected_reset"].includes(entry.kind),
        )
      : [];
    const etag = (value: unknown) => (typeof value === "string" ? value : null);
    return {
      announcements,
      checkedAt: typeof parsed?.checkedAt === "number" ? parsed.checkedAt : null,
      etags: { confirmed: etag(parsed?.etags?.confirmed), promised: etag(parsed?.etags?.promised) },
    };
  } catch {
    return EMPTY_ANNOUNCEMENT_FILE;
  }
}

export const encodeAnnouncementFile = (file: AnnouncementFile): string => `${JSON.stringify(file)}\n`;

/**
 * One read of both feeds folded into the file. A feed that failed or did not
 * change keeps what was known; `checkedAt` moves only when a feed answered.
 */
export function applyFeedReadings(
  file: AnnouncementFile,
  readings: { readonly confirmed: FeedReading; readonly promised: FeedReading },
  now: number,
): AnnouncementFile {
  const read = [
    ...(readings.confirmed.state === "fresh" ? parseConfirmedFeed(readings.confirmed.text, now) : []),
    ...(readings.promised.state === "fresh" ? parsePromisedFeed(readings.promised.text, now) : []),
  ];
  const answered = readings.confirmed.state !== "failed" || readings.promised.state !== "failed";
  return {
    announcements: mergeAnnouncements(file.announcements, read, now),
    checkedAt: answered ? now : file.checkedAt,
    etags: {
      confirmed:
        readings.confirmed.state === "fresh" ? readings.confirmed.etag : file.etags.confirmed,
      promised: readings.promised.state === "fresh" ? readings.promised.etag : file.etags.promised,
    },
  };
}
