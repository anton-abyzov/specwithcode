import { describe, expect, it } from "vite-plus/test";

import { EMPTY_ANNOUNCEMENT_FILE } from "./feeds.ts";
import { announcementToRecord, recordIntoFile } from "./recordTool.ts";

const now = Date.parse("2026-11-15T07:00:00.000Z");
const input = {
  provider: "Codex",
  kind: "full_reset" as const,
  headline: "  Codex reset   usage limits for all paid plans ",
  sourceUrl: "https://x.com/thsottiaux/status/1#reply",
  publishedAt: "2026-11-15T06:30:00Z",
};
const refusal = (extra: Partial<typeof input> | Record<string, unknown>) => {
  const result = announcementToRecord({ ...input, ...extra } as typeof input, now);
  return "refused" in result ? result.refused : null;
};

describe("recording a reset announcement (1340 AC-09)", () => {
  it("keeps a post by link, normalized, with its kind and date", () => {
    const result = announcementToRecord(input, now);
    expect(result).toEqual({
      announcement: {
        id: "recorded:https://x.com/thsottiaux/status/1",
        provider: "codex",
        kind: "full_reset",
        headline: "Codex reset usage limits for all paid plans",
        sourceUrl: "https://x.com/thsottiaux/status/1",
        publishedAt: "2026-11-15T06:30:00.000Z",
      },
    });
  });

  it("refuses what is not a post by the provider or its staff", () => {
    expect(refusal({ provider: "someone" })).toMatch(/provider must be one of/);
    expect(refusal({ kind: "boost" })).toMatch(/kind must be one of/);
    expect(refusal({ headline: "   " })).toBe("headline is empty.");
    expect(refusal({ headline: "x".repeat(241) })).toMatch(/longer than 240/);
    expect(refusal({ sourceUrl: "http://x.com/a/status/1" })).toBe(
      "sourceUrl must be an https link.",
    );
    expect(refusal({ sourceUrl: "not a link" })).toBe("sourceUrl is not a link.");
    expect(refusal({ sourceUrl: "https://user:pw@x.com/a/status/1" })).toMatch(/sign-in/);
    // Another provider's site, a look-alike host and an unrelated site are all refused.
    expect(refusal({ sourceUrl: "https://www.anthropic.com/news/reset" })).toMatch(/own site/);
    expect(refusal({ sourceUrl: "https://x.com.evil.example/a/status/1" })).toMatch(/own site/);
    expect(refusal({ sourceUrl: "https://notopenai.com/reset" })).toMatch(/own site/);
    expect(refusal({ publishedAt: "yesterday" })).toBe("publishedAt is not a date.");
    expect(refusal({ publishedAt: "2026-11-15T08:00:00Z" })).toBe("publishedAt is ahead of now.");
  });

  it("takes the provider's own site and its subdomains", () => {
    expect(refusal({ sourceUrl: "https://help.openai.com/en/articles/1" })).toBeNull();
    expect(
      refusal({ provider: "claude", sourceUrl: "https://www.anthropic.com/news/reset" }),
    ).toBeNull();
    expect(refusal({ sourceUrl: "https://twitter.com/OpenAI/status/2" })).toBeNull();
  });

  it("records a post once, a confirmed post replacing its promise", () => {
    const promise = announcementToRecord({ ...input, kind: "expected_reset" }, now);
    const confirmed = announcementToRecord(input, now);
    if (!("announcement" in promise) || !("announcement" in confirmed)) throw new Error("refused");
    const first = recordIntoFile(EMPTY_ANNOUNCEMENT_FILE, promise.announcement, now);
    expect(first.recorded).toBe(true);
    expect(first.file.announcements).toEqual([promise.announcement]);
    const again = recordIntoFile(first.file, promise.announcement, now);
    expect(again).toEqual({ file: first.file, recorded: false });
    const upgraded = recordIntoFile(first.file, confirmed.announcement, now);
    expect(upgraded.recorded).toBe(true);
    expect(upgraded.file.announcements.map((entry) => entry.kind)).toEqual(["full_reset"]);
    // A promise never replaces the confirmed post.
    expect(recordIntoFile(upgraded.file, promise.announcement, now).recorded).toBe(false);
  });

  it("does not record a post past the retention", () => {
    const old = announcementToRecord({ ...input, publishedAt: "2026-01-01T00:00:00Z" }, now);
    if (!("announcement" in old)) throw new Error("refused");
    expect(recordIntoFile(EMPTY_ANNOUNCEMENT_FILE, old.announcement, now).recorded).toBe(false);
  });
});
