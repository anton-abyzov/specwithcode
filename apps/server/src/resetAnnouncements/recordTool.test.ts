import type { ResetAnnouncement, ResetAnnouncementKind } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { EMPTY_ANNOUNCEMENT_FILE, mergeAnnouncements, parseConfirmedFeed } from "./feeds.ts";
import { announcementToRecord, canonicalPostLink, recordIntoFile } from "./recordTool.ts";

const now = Date.parse("2026-11-15T07:00:00.000Z");
const input = {
  provider: "Codex",
  kind: "full_reset" as ResetAnnouncementKind,
  headline: "  Codex reset   usage limits for all paid plans ",
  sourceUrl: "https://twitter.com/thsottiaux/status/1?s=20#reply",
  publishedAt: "2026-11-15T06:30:00Z",
};
const refusal = (extra: Partial<typeof input> | Record<string, unknown>) => {
  const result = announcementToRecord({ ...input, ...extra } as typeof input, now);
  return "refused" in result ? result.refused : null;
};
const recorded = (extra: Partial<typeof input> = {}) => {
  const result = announcementToRecord({ ...input, ...extra }, now);
  if (!("announcement" in result)) throw new Error(result.refused);
  return result.announcement;
};
const link = (raw: string, provider = "codex") => {
  const result = canonicalPostLink(raw, provider);
  return "link" in result ? result.link : null;
};

describe("recording a reset announcement (1340 AC-09)", () => {
  it("keeps a post under its one canonical link, marked recorded", () => {
    expect(recorded()).toEqual({
      id: "recorded:https://x.com/thsottiaux/status/1",
      provider: "codex",
      kind: "full_reset",
      headline: "Codex reset usage limits for all paid plans",
      sourceUrl: "https://x.com/thsottiaux/status/1",
      publishedAt: "2026-11-15T06:30:00.000Z",
      origin: "recorded",
    });
  });

  it("spells one post one way: X host, case, query, fragment and photo path", () => {
    const one = "https://x.com/openai/status/7";
    for (const spelling of [
      "https://x.com/OpenAI/status/7",
      "https://www.x.com/OpenAI/status/7?s=20",
      "https://twitter.com/OpenAI/status/7#top",
      "https://mobile.twitter.com/OpenAI/status/7/photo/1",
    ])
      expect(link(spelling)).toBe(one);
    expect(link("https://www.openai.com/index/limits/?utm_source=1#x")).toBe(
      "https://openai.com/index/limits",
    );
  });

  it("takes only listed accounts' posts and the provider's own pages", () => {
    expect(link("https://x.com/attacker/status/1")).toBeNull();
    expect(link("https://x.com/explore")).toBeNull();
    expect(link("https://x.com/OpenAI")).toBeNull();
    // An account counts only for its own provider.
    expect(link("https://x.com/AnthropicAI/status/1")).toBeNull();
    expect(link("https://x.com/AnthropicAI/status/1", "claude")).toBe(
      "https://x.com/anthropicai/status/1",
    );
    expect(link("https://x.com:8443/OpenAI/status/1")).toBeNull();
    expect(link("https://openai.com/")).toBeNull();
    expect(link("https://community.openai.com/t/reset/1")).toBeNull();
    expect(link("https://www.anthropic.com/news/reset")).toBeNull();
    expect(link("https://x.com.evil.example/OpenAI/status/1")).toBeNull();
    expect(link("https://notopenai.com/reset")).toBeNull();
    expect(link("https://help.openai.com/en/articles/1")).toBe(
      "https://help.openai.com/en/articles/1",
    );
    expect(link("https://www.anthropic.com/news/reset", "claude")).toBe(
      "https://anthropic.com/news/reset",
    );
  });

  it("refuses what is not a clear, dated post", () => {
    expect(refusal({ provider: "someone" })).toMatch(/provider must be one of/);
    expect(refusal({ provider: "gemini" })).toMatch(/provider must be one of/);
    expect(refusal({ kind: "boost" })).toMatch(/kind must be one of/);
    expect(refusal({ headline: "   " })).toBe("headline is empty.");
    expect(refusal({ headline: "x".repeat(241) })).toMatch(/longer than 240/);
    expect(refusal({ sourceUrl: "http://x.com/OpenAI/status/1" })).toBe(
      "sourceUrl must be an https link.",
    );
    expect(refusal({ sourceUrl: "not a link" })).toBe("sourceUrl is not a link.");
    expect(refusal({ sourceUrl: "https://user:pw@x.com/OpenAI/status/1" })).toMatch(/sign-in/);
    expect(refusal({ publishedAt: "15 Nov 2026" })).toMatch(/ISO date and time/);
    expect(refusal({ publishedAt: "2026-11-15" })).toMatch(/ISO date and time/);
    expect(refusal({ publishedAt: "2026-11-15T08:00:00Z" })).toBe("publishedAt is ahead of now.");
    expect(refusal({ publishedAt: "2026-11-15T01:30:00-05:00" })).toBeNull();
  });

  it("records a post once, a confirmed recording replacing a recorded promise", () => {
    const promise = recorded({ kind: "expected_reset" });
    const confirmed = recorded();
    const first = recordIntoFile(EMPTY_ANNOUNCEMENT_FILE, promise, now);
    expect(first.recorded).toBe(true);
    expect(first.file.announcements).toEqual([promise]);
    expect(recordIntoFile(first.file, recorded({ kind: "expected_reset" }), now)).toEqual({
      file: first.file,
      recorded: false,
    });
    const upgraded = recordIntoFile(first.file, confirmed, now);
    expect(upgraded.recorded).toBe(true);
    expect(upgraded.file.announcements.map((entry) => entry.kind)).toEqual(["full_reset"]);
    expect(recordIntoFile(upgraded.file, promise, now).recorded).toBe(false);
  });

  it("never shadows the verified feed: the feed replaces a recording, never the other way", () => {
    const mine = recorded({ headline: "A wrong headline" });
    const feed: ResetAnnouncement = {
      id: "codex-reset",
      provider: "codex",
      kind: "expected_reset",
      headline: "Codex reset promised by end of day",
      sourceUrl: mine.sourceUrl,
      publishedAt: mine.publishedAt,
    } as ResetAnnouncement;
    // The feed's promise replaces the recorded confirmation for the same post.
    expect(mergeAnnouncements([mine], [feed], now)).toEqual([feed]);
    // And a later recording does not replace the feed's item.
    const file = { ...EMPTY_ANNOUNCEMENT_FILE, announcements: [feed] };
    expect(recordIntoFile(file, mine, now)).toEqual({ file, recorded: false });
  });

  it("spells feed links the same way, so the feed and a recording of one post are one", () => {
    const feedItem = (sourceUrl: string, id = "codex-reset") =>
      JSON.stringify({
        items: [
          {
            id,
            provider: "codex",
            kind: "hard-reset",
            evidence: "verified",
            headline: "Codex reset usage limits",
            sourceUrl,
            publishedAt: "2026-11-15T06:30:00.000Z",
          },
        ],
      });
    const [feed] = parseConfirmedFeed(feedItem("https://twitter.com/OpenAI/status/0001?s=20"), now);
    expect(feed?.sourceUrl).toBe("https://x.com/openai/status/1");
    const mine = recorded({ sourceUrl: "https://mobile.x.com/OpenAI/status/1" });
    expect(mergeAnnouncements([mine], [feed!], now)).toEqual([feed]);
    const [again] = parseConfirmedFeed(
      feedItem("https://x.com/openai/status/1#a", "other-id"),
      now,
    );
    expect(mergeAnnouncements([feed!], [again!], now)).toHaveLength(1);
    // A page keeps what tells it apart, and loses what does not.
    const [page] = parseConfirmedFeed(
      feedItem("https://www.openai.com//index/%69ndex/?utm_source=x&p=2#top"),
      now,
    );
    expect(page?.sourceUrl).toBe("https://openai.com/index/index?p=2");
  });

  it("records a page once under its plain spelling", () => {
    for (const spelling of [
      "https://openai.com/index/reset",
      "https://openai.com//index/reset",
      "https://openai.com/index//reset/",
      "https://openai.com/%69ndex/reset",
      "https://www.openai.com/index/reset?utm_source=x",
    ])
      expect(link(spelling)).toBe("https://openai.com/index/reset");
    // A query that picks the page stays, sorted, so two pages stay two.
    expect(link("https://openai.com/index/reset?p=2")).toBe("https://openai.com/index/reset?p=2");
    expect(link("https://openai.com/post?s=beta&s=alpha")).toBe(
      "https://openai.com/post?s=alpha&s=beta",
    );
    expect(link("https://openai.com/post?s=alpha")).not.toBe(
      link("https://openai.com/post?s=beta"),
    );
  });

  it("lets the feed replace a recorded page with a query", () => {
    const mine = recorded({ sourceUrl: "https://www.openai.com/index/reset?p=2&utm_medium=x" });
    const [feed] = parseConfirmedFeed(
      JSON.stringify({
        items: [
          {
            id: "page",
            provider: "codex",
            kind: "hard-reset",
            evidence: "verified",
            headline: "Codex reset usage limits",
            sourceUrl: "https://openai.com/index/reset/?p=2",
            publishedAt: "2026-11-15T06:30:00.000Z",
          },
        ],
      }),
      now,
    );
    expect(mergeAnnouncements([mine], [feed!], now)).toEqual([feed]);
  });

  it("refuses a calendar day that does not exist", () => {
    expect(refusal({ publishedAt: "2026-02-31T06:30:00Z" })).toMatch(/ISO date and time/);
    expect(refusal({ publishedAt: "2026-11-31T06:30:00Z" })).toMatch(/ISO date and time/);
    expect(refusal({ publishedAt: "2024-02-29T06:30:00Z" })).toBeNull();
  });

  it("does not record a post past the retention", () => {
    expect(
      recordIntoFile(
        EMPTY_ANNOUNCEMENT_FILE,
        recorded({ publishedAt: "2026-01-01T00:00:00Z" }),
        now,
      ).recorded,
    ).toBe(false);
  });
});
