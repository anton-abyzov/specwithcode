import type { ResetAnnouncement } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ResetAnnouncements } from "./ResetAnnouncements";
import { announcementDriver } from "./resetAnnouncementsState";

const now = Date.parse("2026-11-14T20:00:00.000Z");
const DAY = 24 * 60 * 60_000;

const post = (index: number, extra: Partial<ResetAnnouncement> = {}): ResetAnnouncement =>
  ({
    id: `post-${index}`,
    provider: "codex",
    kind: "full_reset",
    headline: `Codex resets limits, post ${index}`,
    sourceUrl: `https://x.com/example/status/${index}`,
    publishedAt: new Date(now - index * DAY).toISOString(),
    ...extra,
  }) as ResetAnnouncement;

const render = (announcements: readonly ResetAnnouncement[], extra: object = {}) =>
  renderToStaticMarkup(
    <ResetAnnouncements
      announcements={announcements}
      checkedAt={now}
      enabled
      now={now}
      {...extra}
    />,
  );

describe("ResetAnnouncements", () => {
  it("lists date, provider, kind and the source link, five at a time", () => {
    const html = render([
      post(1),
      post(2, { kind: "banked_grant" }),
      post(3, { kind: "limit_change", provider: "claude" }),
      post(4, { kind: "expected_reset" }),
      post(5),
      post(6),
    ]);
    expect(html).toContain("Codex · Full reset");
    expect(html).toContain("Codex · Banked reset");
    expect(html).toContain("Claude · Limit change");
    expect(html).toContain("Codex · Reset expected");
    expect(html).toContain('href="https://x.com/example/status/1"');
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).not.toContain("post 6");
    expect(html).toContain("Show all 6");
    expect(html).not.toContain("data-reset-announcements-note");
  });

  it("says when the feed looks stopped, is off, or has not answered", () => {
    expect(render([post(20)])).toContain("It may have stopped updating.");
    expect(render([post(1)], { enabled: false })).toContain("turned off in Settings");
    expect(render([], { checkedAt: null })).toContain("has not answered yet");
    expect(render([])).toContain("No announcement has been read yet.");
  });

  it("maps a feed's provider to the driver whose accounts it concerns", () => {
    expect(announcementDriver("codex")).toBe("codex");
    expect(announcementDriver("Claude")).toBe("claudeAgent");
    expect(announcementDriver("unknown")).toBeNull();
  });
});
