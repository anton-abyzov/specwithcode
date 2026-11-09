/**
 * Pure parts of the Away summary and the wake card: how a session's items
 * group (Moved, Paused, Stayed), how each reads before and after Bring back,
 * and when the wake card asks to bring work back (D-02).
 */
import {
  type AwayItemResult,
  type AwaySession,
  type AwaySnapshot,
  awaitsBringBack,
  type EnvironmentId,
} from "@specweave-studio/contracts";

/** How often an open summary or wake card asks the server for the session. */
export const AWAY_SESSION_POLL_MS = 2_000;
export const AWAY_WAKE_POLL_MS = 30_000;

export type AwaySummaryKey = "moved" | "paused" | "stayed" | "waiting";

export interface AwaySummaryRow {
  readonly key: string;
  readonly item: AwayItemResult;
  readonly label: string;
  readonly tone: "ready" | "attention" | "muted";
  readonly detail: string;
  /** Opens the thread that continues it, on the machine that runs it now. */
  readonly open: { readonly threadId: string; readonly environmentId: EnvironmentId } | null;
}

export interface AwaySummaryGroup {
  readonly key: AwaySummaryKey;
  readonly title: string;
  readonly rows: readonly AwaySummaryRow[];
}

const KIND_ORDER = { coordinator: 0, thread: 1, routine: 2 } as const;

function groupOf(item: AwayItemResult): AwaySummaryKey {
  if (item.outcome === "moved") return "moved";
  if (item.outcome === "paused") return "paused";
  // Not reached yet while Leave runs; it has not stayed.
  if (item.outcome === "pending") return "waiting";
  return "stayed";
}

/** The label and tone of one item, after Bring back when it ran. */
export function awayItemLabel(
  item: AwayItemResult,
  targetLabel: string,
): Pick<AwaySummaryRow, "label" | "tone"> {
  if (item.back !== undefined) {
    switch (item.back.outcome) {
      case "returned":
        return { label: "Back", tone: "ready" };
      case "stayed":
        return { label: `Stays on ${targetLabel}`, tone: "muted" };
      case "failed":
        return { label: "Not back yet", tone: "attention" };
    }
  }
  switch (item.outcome) {
    case "pending":
      return { label: "Waiting", tone: "muted" };
    case "moved":
      return { label: "Moved", tone: "ready" };
    case "paused":
      return { label: "Paused", tone: "muted" };
    case "handoff-ready":
      return { label: "Ready to move", tone: "attention" };
    case "stayed":
      return { label: "Stays here", tone: "muted" };
    case "failed":
      return { label: "Not moved", tone: "attention" };
  }
}

/** Rows grouped Moved, Paused, Stayed, then Waiting while Leave runs; coordinators first in each, then threads, then routines. */
export function summarizeAwaySession(
  session: AwaySession,
  selfEnvironmentId: EnvironmentId,
): readonly AwaySummaryGroup[] {
  const titles: Record<AwaySummaryKey, string> = {
    moved: `Moved to ${session.targetLabel}`,
    paused: "Paused here",
    stayed: "Stayed here",
    waiting: "Waiting",
  };
  const groups: Record<AwaySummaryKey, AwaySummaryRow[]> = {
    moved: [],
    paused: [],
    stayed: [],
    waiting: [],
  };
  const items = session.items.toSorted((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  for (const item of items) {
    const label = awayItemLabel(item, session.targetLabel);
    const backHere = item.back?.outcome === "returned" && item.back.localId !== undefined;
    const open =
      item.kind !== "thread"
        ? null
        : backHere
          ? { threadId: item.back!.localId!, environmentId: selfEnvironmentId }
          : item.outcome === "moved" &&
              item.targetId !== undefined &&
              item.back?.outcome !== "returned"
            ? { threadId: item.targetId, environmentId: session.targetEnvironmentId }
            : null;
    groups[groupOf(item)].push({
      key: `${item.kind}:${item.id}`,
      item,
      ...label,
      detail: item.back?.detail ?? item.detail,
      open,
    });
  }
  return (["moved", "paused", "stayed", "waiting"] as const)
    .filter((key) => groups[key].length > 0)
    .map((key) => ({ key, title: `${titles[key]} (${groups[key].length})`, rows: groups[key] }));
}

/** One line over the summary. */
export function awaySessionHeadline(session: AwaySession, running: boolean): string {
  const count = (outcome: AwayItemResult["outcome"]) =>
    session.items.filter((item) => item.outcome === outcome).length;
  const moved = count("moved");
  const left = session.items.length - moved - count("paused");
  if (session.broughtBackAt !== null) return `Your work is back from ${session.targetLabel}.`;
  if (session.bringBackStartedAt !== null)
    return running
      ? `Bringing work back from ${session.targetLabel}…`
      : `Some work is still on ${session.targetLabel}. Bring back again to retry.`;
  if (session.finishedAt === null)
    return running
      ? `Moving work to ${session.targetLabel}…`
      : `Leaving for ${session.targetLabel} did not finish. Leave again to finish it.`;
  const movedText = moved === 1 ? "1 item moved" : `${moved} items moved`;
  return left === 0
    ? `${movedText} to ${session.targetLabel}.`
    : `${movedText} to ${session.targetLabel}. ${left} stayed here.`;
}

/** Whether the wake card asks to bring work back (D-02 `prompt`), unless dismissed for this session. */
export function showAwayWakeCard(
  snapshot: AwaySnapshot | null,
  dismissedSessionId: string | null,
): boolean {
  if (snapshot === null || snapshot.running) return false;
  if (snapshot.settings.bringBack !== "prompt") return false;
  const session = snapshot.session;
  if (session === null || session.finishedAt === null) return false;
  if (session.sessionId === dismissedSessionId) return false;
  return awaitsBringBack(session);
}
