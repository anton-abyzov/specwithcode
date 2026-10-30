/**
 * What still keeps an update waiting, as rows read from the database and as
 * the per-thread summary `prepareServiceUpdate` answers with.
 *
 * @module ServiceUpdateBlockers
 */
import {
  ProjectId,
  ThreadId,
  type ServiceUpdateBlocker,
  type ServiceUpdateBlockerKind,
} from "@specweave-studio/contracts";

import * as ClosedQuestions from "./ServiceUpdateClosedQuestions.ts";

export interface BlockerRow {
  readonly kind: ServiceUpdateBlockerKind;
  readonly threadId: string | null;
  readonly threadTitle: string | null;
  readonly projectId: string | null;
  readonly projectTitle: string | null;
  /** Set for `run` and `queued` rows. */
  readonly runId?: string | null;
  /** Set for `request` rows: the runtime request's kind. */
  readonly requestKind?: string | null;
}

const KIND_ORDER: Record<ServiceUpdateBlockerKind, number> = {
  run: 0,
  request: 1,
  queued: 2,
  session: 3,
  effect: 4,
};

/** One entry per thread and kind, running work first, then by project and thread. */
export function summarizeBlockers(rows: ReadonlyArray<BlockerRow>): Array<ServiceUpdateBlocker> {
  const grouped = new Map<string, ServiceUpdateBlocker>();
  for (const row of rows) {
    const key = `${row.kind}\u0000${row.threadId ?? ""}`;
    const existing = grouped.get(key);
    if (existing) {
      grouped.set(key, { ...existing, count: existing.count + 1 });
      continue;
    }
    grouped.set(key, {
      kind: row.kind,
      count: 1,
      threadId: row.threadId === null ? null : ThreadId.make(row.threadId),
      threadTitle: row.threadTitle,
      projectId: row.projectId === null ? null : ProjectId.make(row.projectId),
      projectTitle: row.projectTitle,
    });
  }
  // What a forced press closes and asks again: questions and approvals by thread.
  for (const row of rows) {
    if (row.kind !== "request" || row.requestKind === undefined) continue;
    const key = `${row.kind}\u0000${row.threadId ?? ""}`;
    const blocker = grouped.get(key);
    if (blocker === undefined) continue;
    const kind = row.requestKind ?? "";
    grouped.set(key, {
      ...blocker,
      questions:
        (blocker.questions ?? 0) + (ClosedQuestions.QUESTION_REQUEST_KINDS.has(kind) ? 1 : 0),
      approvals: (blocker.approvals ?? 0) + (ClosedQuestions.APPROVAL_KINDS.has(kind) ? 1 : 0),
    });
  }
  return [...grouped.values()].toSorted(
    (left, right) =>
      KIND_ORDER[left.kind] - KIND_ORDER[right.kind] ||
      (left.projectTitle ?? "").localeCompare(right.projectTitle ?? "") ||
      (left.threadTitle ?? "").localeCompare(right.threadTitle ?? ""),
  );
}
