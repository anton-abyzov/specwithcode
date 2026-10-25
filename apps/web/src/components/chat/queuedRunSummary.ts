/**
 * How a queued message reads in the queue: one plain line instead of the
 * start of a Markdown report, and how long it has waited.
 */

const MAX_LINE = 160;

/** The notification's own summary when it has one, else the message's first readable line. */
export function queuedRunOneLine(text: string, summary?: string | null): string {
  if (summary && summary.trim().length > 0) return clip(summary.trim());
  const withoutCode = text.replace(/```[\s\S]*?(?:```|$)/g, " ");
  const line =
    withoutCode
      .split("\n")
      .map((candidate) =>
        candidate
          // Headings, quotes, list markers and task boxes at the start of a line.
          .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
          // Emphasis, inline code and links keep only their text.
          .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/(\*\*|__|`)/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((candidate) => candidate.length > 0 && !/^[-=*_]{3,}$/.test(candidate)) ?? "";
  return clip(line.length > 0 ? line : text.trim());
}

function clip(line: string): string {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** "queued just now", "queued 12 min", "queued 2 h 5 min"; null without a time. */
export function queuedAgeLabel(queuedAtMs: number | null, nowMs: number): string | null {
  if (queuedAtMs === null) return null;
  const minutes = Math.floor(Math.max(0, nowMs - queuedAtMs) / 60_000);
  if (minutes < 1) return "queued just now";
  if (minutes < 60) return `queued ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `queued ${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `queued ${Math.floor(hours / 24)} d`;
}

// Why the queue's actions (steer, delete, discard, reorder, edit) are off, or null when
// they work. Every queue view of a thread passes the same reason.
export function queuedRunActionsUnavailableReason(input: {
  readonly canOperateThread: boolean;
  readonly environmentUnavailable: boolean;
  readonly environmentLabel: string | null;
}): string | null {
  if (!input.canOperateThread) return "This connection cannot change threads.";
  if (input.environmentUnavailable)
    return `${input.environmentLabel ?? "This machine"} is not connected.`;
  return null;
}
