import type { ResetAnnouncement } from "@specweave-studio/contracts";
import { useState } from "react";

/** The feed is treated as stopped when its newest event is older than this. */
const STALE_FEED_MS = 14 * 24 * 60 * 60_000;
const PAGE = 5;

const KIND_LABEL: Record<ResetAnnouncement["kind"], string> = {
  full_reset: "Full reset",
  banked_grant: "Banked reset",
  limit_change: "Limit change",
  expected_reset: "Reset expected",
};

const day = (at: number) =>
  new Date(at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });

/** "codex" reads "Codex" in a list. */
const providerName = (provider: string) => provider.charAt(0).toUpperCase() + provider.slice(1);

/**
 * Posts in which a provider reset limits, granted a banked reset, changed a
 * limit or promised a reset, newest first. Says so when the feed looks stopped
 * or is turned off, so an empty or old list is not read as "nothing happened".
 */
export function ResetAnnouncements({
  announcements,
  checkedAt,
  enabled,
  now,
}: {
  readonly announcements: readonly ResetAnnouncement[];
  readonly checkedAt: number | null;
  readonly enabled: boolean;
  readonly now: number;
}) {
  const [all, setAll] = useState(false);
  // The feed's own newest post: one an agent recorded says nothing about whether the feed stopped.
  const fromFeed = announcements.find((announcement) => announcement.origin !== "recorded");
  const newest = fromFeed === undefined ? null : Date.parse(fromFeed.publishedAt);
  const note = !enabled
    ? "The announcement feed is turned off in Settings > Models, so this list is not updated."
    : checkedAt === null
      ? "The announcement feed has not answered yet."
      : newest !== null && now - newest > STALE_FEED_MS
        ? `The feed's newest event is from ${day(newest)}. It may have stopped updating.`
        : null;
  const shown = all ? announcements : announcements.slice(0, PAGE);
  return (
    <section
      className="flex flex-col gap-3"
      aria-labelledby="reset-announcements-heading"
      data-reset-announcements=""
    >
      <h3 id="reset-announcements-heading" className="text-sm font-medium">
        Reset announcements
      </h3>
      {note !== null ? (
        <p className="text-xs text-muted-foreground" data-reset-announcements-note="">
          {note}
        </p>
      ) : null}
      {announcements.length === 0 ? (
        <p className="text-sm text-muted-foreground">No announcement has been read yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {shown.map((announcement) => (
            <li
              key={announcement.sourceUrl}
              className="flex flex-col gap-1 p-3 text-sm sm:flex-row sm:items-baseline sm:gap-3"
              data-reset-announcement={announcement.kind}
            >
              <span className="shrink-0 text-xs text-muted-foreground sm:w-36">
                {day(Date.parse(announcement.publishedAt))}
              </span>
              <span className="shrink-0 text-xs font-medium sm:w-40">
                {providerName(announcement.provider)} · {KIND_LABEL[announcement.kind]}
              </span>
              <a
                className="min-w-0 flex-1 text-foreground underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                href={announcement.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                {announcement.headline}
              </a>
              {announcement.origin === "recorded" ? (
                <span
                  className="shrink-0 text-xs text-muted-foreground"
                  data-reset-announcement-recorded=""
                >
                  Read by your routine, not verified
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {announcements.length > PAGE ? (
        <button
          type="button"
          className="self-start rounded-sm text-xs font-medium underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-expanded={all}
          onClick={() => setAll(!all)}
        >
          {all ? "Show fewer" : `Show all ${announcements.length}`}
        </button>
      ) : null}
    </section>
  );
}
