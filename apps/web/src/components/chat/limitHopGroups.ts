import type { TranslatePhrase } from "../../i18n";
import { limitContinuationKind } from "../../studio/runIdentity";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/**
 * Two or more automatic usage-limit hops in a row, as one line: "Usage limits ·
 * switched 14 times between Copilot and Cursor" (1460 AC-06). Opening it shows
 * the original rows below it.
 */
export interface LimitHopsRow {
  kind: "limit-hops";
  id: string;
  createdAt: string;
  groupId: string;
  expanded: boolean;
  /** Completed hops: a usage-limit stop followed by a switch or a continuation note. */
  hopCount: number;
  /** Provider instances the switches name, in first-seen order. */
  sourceInstanceIds: string[];
  /** Stopped and continuing runs in order, to name sources when no switch row does. */
  runIds: string[];
}

type Row = MessagesTimelineRow;

function failureItem(row: Row) {
  if (row.kind !== "work" || row.groupedEntries.length !== 1) return null;
  const item = row.groupedEntries[0]!.projectedItem?.item;
  return item?.type === "error" && item.status === "failed" && item.failure.class === "usage_limit"
    ? item
    : null;
}

function handoffItem(row: Row) {
  return row.kind === "event" && row.projectedItem.item.type === "handoff"
    ? row.projectedItem.item
    : null;
}

/** The server's "continue" request after a stop; a provider that could not start is no limit. */
function isLimitNote(row: Row): row is Extract<Row, { kind: "message" }> {
  if (row.kind !== "message" || row.message.role !== "user") return false;
  const kind = limitContinuationKind(row.message.id);
  return kind !== null && kind !== "provider-fallback";
}

/**
 * Folds every stretch of two or more limit hops into one summary row. A hop is
 * a usage-limit failure and the switch or continuation note after it. Inside a
 * stretch only a stopped run's own text may sit between hops: a provider that
 * hit its limit often writes the refusal as a reply ("Error: You have exceeded
 * your monthly quota"). Any other message, tool work or live row ends it, and
 * a last stop not yet continued stays visible below the summary.
 */
export function foldLimitHops(
  rows: ReadonlyArray<Row>,
  isExpanded: (groupId: string) => boolean,
): Row[] {
  const stoppedRunIds = new Set<string>();
  for (const row of rows) {
    const runId = failureItem(row)?.runId;
    if (runId) stoppedRunIds.add(runId);
  }
  if (stoppedRunIds.size < 2) return [...rows];
  const isStoppedRunText = (row: Row) =>
    (row.kind === "message" || row.kind === "assistant-meta") &&
    row.message.role === "assistant" &&
    row.message.runId != null &&
    stoppedRunIds.has(row.message.runId);

  const out: Row[] = [];
  let index = 0;
  while (index < rows.length) {
    if (failureItem(rows[index]!) === null) {
      out.push(rows[index]!);
      index += 1;
      continue;
    }
    let hops = 0;
    let pending = false;
    let end = index;
    for (let cursor = index; cursor < rows.length; cursor += 1) {
      const row = rows[cursor]!;
      if (failureItem(row) !== null) {
        if (pending) break;
        pending = true;
      } else if (handoffItem(row) !== null || isLimitNote(row)) {
        if (pending) hops += 1;
        pending = false;
        end = cursor + 1;
      } else if (!isStoppedRunText(row)) break;
    }
    if (hops < 2) {
      out.push(rows[index]!);
      index += 1;
      continue;
    }
    const span = rows.slice(index, end);
    out.push(...summarize(span, hops, isExpanded));
    index = end;
  }
  return out;
}

function summarize(
  span: ReadonlyArray<Row>,
  hopCount: number,
  isExpanded: (groupId: string) => boolean,
): Row[] {
  const first = span[0]!;
  const groupId = `limit-hops:${first.id}`;
  const expanded = isExpanded(groupId);
  const sourceInstanceIds = new Set<string>();
  const runIds = new Set<string>();
  const add = (set: Set<string>, value: string | null | undefined) => {
    if (value) set.add(value);
  };
  const spanMessageIds = new Set(
    span.flatMap((row) => (row.kind === "message" ? [row.message.id] : [])),
  );
  // The details of a reply above the stretch stay with that reply.
  const kept: Row[] = [];
  const hidden: Row[] = [];
  for (const row of span) {
    if (row.kind === "assistant-meta" && !spanMessageIds.has(row.message.id)) {
      kept.push(row);
      continue;
    }
    hidden.push(row);
    const handoff = handoffItem(row);
    if (handoff) {
      for (const id of handoff.fromProviderInstanceIds) add(sourceInstanceIds, id);
      add(sourceInstanceIds, handoff.toProviderInstanceId);
    }
    add(runIds, failureItem(row)?.runId);
    if (isLimitNote(row)) add(runIds, row.message.runId);
  }
  const summary: LimitHopsRow = {
    kind: "limit-hops",
    id: groupId,
    createdAt: first.createdAt ?? "",
    groupId,
    expanded,
    hopCount,
    sourceInstanceIds: [...sourceInstanceIds],
    // Only needed when no switch row names a source.
    runIds: sourceInstanceIds.size > 0 ? [] : [...runIds],
  };
  return [
    ...kept,
    summary,
    ...(expanded ? hidden.map((row) => ({ ...row, withinToolActivity: true })) : []),
  ];
}

export function sameLimitHopsRow(a: LimitHopsRow, b: LimitHopsRow): boolean {
  return (
    a.createdAt === b.createdAt &&
    a.expanded === b.expanded &&
    a.hopCount === b.hopCount &&
    a.sourceInstanceIds.join() === b.sourceInstanceIds.join() &&
    a.runIds.join() === b.runIds.join()
  );
}

/**
 * The summary's words. `sources` are display names; a name two instances share
 * is said once, in first-seen order.
 */
export function limitHopsSummary(
  hopCount: number,
  sources: ReadonlyArray<string>,
  tx: TranslatePhrase,
  joinList: (items: ReadonlyArray<string>) => string,
): string {
  const names = [...new Set(sources.map((name) => name.trim()).filter(Boolean))];
  if (names.length >= 2)
    return tx("Usage limits · switched {count} times between {sources}", {
      count: hopCount,
      sources: joinList(names),
    });
  if (names.length === 1)
    return tx("Usage limits · {count} stops on {source}", { count: hopCount, source: names[0]! });
  return tx("Usage limits · {count} stops", { count: hopCount });
}
