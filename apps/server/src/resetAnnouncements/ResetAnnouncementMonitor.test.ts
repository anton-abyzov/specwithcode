import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_ANNOUNCEMENT_FILE,
  applyFeedReadings,
  decodeAnnouncementFile,
  fetchFeed,
  mergeAnnouncements,
  parseConfirmedFeed,
  parsePromisedFeed,
} from "./feeds.ts";

const now = Date.parse("2026-11-14T20:00:00.000Z");
const DAY = 24 * 60 * 60_000;

const item = (extra: Record<string, unknown> = {}) => ({
  id: "codex-reset-2026-11-14",
  provider: "codex",
  kind: "hard-reset",
  evidence: "verified",
  headline: "Codex resets usage limits for all paid accounts",
  body: "ignored",
  sourceUrl: "https://x.com/example/status/1",
  publishedAt: "2026-11-14T15:00:00.000Z",
  ...extra,
});
const feed = (...items: unknown[]) => JSON.stringify({ items });

describe("reset announcement feeds", () => {
  it("keeps verified, typed, linked items and names their kind", () => {
    const parsed = parseConfirmedFeed(
      feed(
        item(),
        item({ id: "b", kind: "banked-reset", sourceUrl: "https://x.com/example/status/2" }),
        item({ id: "c", kind: "boost", sourceUrl: "https://x.com/example/status/3" }),
      ),
    );
    expect(parsed.map((entry) => entry.kind)).toEqual(["full_reset", "banked_grant", "limit_change"]);
    expect(parsed[0]).toEqual({
      id: "codex-reset-2026-11-14",
      provider: "codex",
      kind: "full_reset",
      headline: "Codex resets usage limits for all paid accounts",
      sourceUrl: "https://x.com/example/status/1",
      publishedAt: "2026-11-14T15:00:00.000Z",
    });
  });

  it("drops what it cannot trust: unverified, untyped, unlinked, undated or not a feed", () => {
    expect(
      parseConfirmedFeed(
        feed(
          item({ evidence: "rumour" }),
          item({ kind: "policy" }),
          item({ sourceUrl: "javascript:alert(1)" }),
          item({ sourceUrl: "http://x.com/example/status/1" }),
          item({ publishedAt: "soon" }),
          item({ headline: "  " }),
          null,
          "text",
        ),
      ),
    ).toEqual([]);
    expect(parseConfirmedFeed("<html>")).toEqual([]);
    expect(parseConfirmedFeed(JSON.stringify({ items: "no" }))).toEqual([]);
    expect(parseConfirmedFeed(feed(item({ headline: "x".repeat(900) })))[0]?.headline).toHaveLength(240);
  });

  it("reads a promise only from the promised feed", () => {
    const promise = item({ kind: "reset-untyped", headline: "A reset is promised by end of day" });
    expect(parsePromisedFeed(feed(promise, item({ kind: "policy" }))).map((entry) => entry.kind)).toEqual([
      "expected_reset",
    ]);
    expect(parseConfirmedFeed(feed(promise))).toEqual([]);
  });

  it("keeps each post once, a confirmed event replacing its promise, newest first", () => {
    const [promise] = parsePromisedFeed(feed(item({ kind: "reset-untyped" })));
    const [confirmed] = parseConfirmedFeed(feed(item()));
    const [older] = parseConfirmedFeed(
      feed(item({ id: "old", sourceUrl: "https://x.com/example/status/0", publishedAt: "2026-11-01T00:00:00.000Z" })),
    );
    const merged = mergeAnnouncements([promise!, older!], [confirmed!, promise!], now);
    expect(merged.map((entry) => [entry.id, entry.kind])).toEqual([
      ["codex-reset-2026-11-14", "full_reset"],
      ["old", "full_reset"],
    ]);
    // A promise never replaces the confirmed event for the same post.
    expect(mergeAnnouncements([confirmed!], [promise!], now)[0]?.kind).toBe("full_reset");
    // Past the retention it leaves the list.
    expect(mergeAnnouncements([older!], [], now + 200 * DAY)).toEqual([]);
  });

  it("folds a read into the file and keeps what it knew when a feed fails or is unchanged", () => {
    const first = applyFeedReadings(
      EMPTY_ANNOUNCEMENT_FILE,
      {
        confirmed: { state: "fresh", text: feed(item()), etag: '"a"' },
        promised: { state: "failed" },
      },
      now,
    );
    expect(first.announcements).toHaveLength(1);
    expect(first.checkedAt).toBe(now);
    expect(first.etags).toEqual({ confirmed: '"a"', promised: null });
    const second = applyFeedReadings(
      first,
      { confirmed: { state: "unchanged" }, promised: { state: "failed" } },
      now + 1000,
    );
    expect(second.announcements).toEqual(first.announcements);
    expect(second.checkedAt).toBe(now + 1000);
    const offline = applyFeedReadings(
      second,
      { confirmed: { state: "failed" }, promised: { state: "failed" } },
      now + 2000,
    );
    expect(offline.checkedAt).toBe(now + 1000);
    expect(decodeAnnouncementFile(JSON.stringify(offline))).toEqual(offline);
    expect(decodeAnnouncementFile("not json")).toEqual(EMPTY_ANNOUNCEMENT_FILE);
  });

  it("asks conditionally and reads 304 as unchanged", async () => {
    const seen: Array<string | null> = [];
    const fetcher = (async (_url: unknown, init?: RequestInit) => {
      const etag = new Headers(init?.headers).get("if-none-match");
      seen.push(etag);
      return etag === '"a"'
        ? new Response(null, { status: 304 })
        : new Response(feed(item()), { status: 200, headers: { etag: '"a"' } });
    }) as typeof globalThis.fetch;
    const fresh = await fetchFeed("https://feed.example/alert.json", null, fetcher);
    expect(fresh).toMatchObject({ state: "fresh", etag: '"a"' });
    expect(await fetchFeed("https://feed.example/alert.json", '"a"', fetcher)).toEqual({
      state: "unchanged",
    });
    expect(seen).toEqual([null, '"a"']);
    const failing = (async () => new Response("no", { status: 500 })) as typeof globalThis.fetch;
    expect(await fetchFeed("https://feed.example/alert.json", null, failing)).toEqual({ state: "failed" });
    const throwing = (async () => {
      throw new Error("offline");
    }) as typeof globalThis.fetch;
    expect(await fetchFeed("https://feed.example/alert.json", null, throwing)).toEqual({ state: "failed" });
  });
});
