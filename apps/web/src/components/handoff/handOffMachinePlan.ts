import type {
  HandoffPlanUsage,
  HandoffPlanView,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";

import { englishPhrase, type TranslatePhrase } from "~/i18n";

import type { HandoffMachineGroup, HandoffMachineThreadRow } from "./handOffMachineRows";

const FOLDER_WORK = "folder-work:";

/** A folder work row's key among the dialog's thread ids: a project id is not a thread's. */
export const folderWorkRowId = (projectId: ProjectId) => `${FOLDER_WORK}${projectId}` as ThreadId;

/** The projects whose folder work is ticked, in tick order. */
export function folderWorkTicked(ticks: Iterable<ThreadId>): ProjectId[] {
  return [...ticks]
    .filter((id) => id.startsWith(FOLDER_WORK))
    .map((id) => id.slice(FOLDER_WORK.length) as ProjectId);
}

/** The ticked thread ids, without folder work rows. */
export function threadsTicked(ticks: Iterable<ThreadId>): ThreadId[] {
  return [...ticks].filter((id) => !id.startsWith(FOLDER_WORK));
}

/** One provider's line under a machine in the target picker (AC-22). */
export function handoffUsageLine(
  usage: HandoffPlanUsage,
  sourceLabel: string,
  tx: TranslatePhrase = englishPhrase,
): string {
  switch (usage.kind) {
    case "different-account":
      return usage.percentLeft === null
        ? tx("Usage unknown")
        : tx("Different {provider} account · {n}% left", {
            provider: usage.providerName,
            n: usage.percentLeft,
          });
    case "same-account":
      return tx("Same {provider} account as {source}: adds no usage", {
        provider: usage.providerName,
        source: sourceLabel,
      });
    case "usage-unknown":
      return tx("Usage unknown");
  }
}

/** Every provider line of one machine; none when it could not be asked. */
export function handoffUsageLines(
  view: HandoffPlanView,
  tx: TranslatePhrase = englishPhrase,
): string[] {
  if (view.unreachable !== null) return [];
  return view.usage.map((usage) => handoffUsageLine(usage, view.sourceLabel, tx));
}

const ORDER: Record<HandoffMachineGroup, number> = {
  running: 0,
  queued: 1,
  waiting: 2,
  unsaved: 3,
  "folder-work": 4,
  stays: 5,
};

/** The dialog's rows from the plan the source read (AC-17), grouped in AC-17's order. */
export function planHandoffRows(view: HandoffPlanView): HandoffMachineThreadRow[] {
  return view.items
    .map((item, index) => ({
      index,
      row: {
        threadId:
          item.kind === "folder-work" ? folderWorkRowId(item.projectId) : (item.id as ThreadId),
        title: item.title || "Untitled thread",
        group: item.group,
        reason: item.reason,
        kind: item.kind,
        canTick: item.canTick,
      } satisfies HandoffMachineThreadRow,
    }))
    .toSorted((a, b) => ORDER[a.row.group] - ORDER[b.row.group] || a.index - b.index)
    .map(({ row }) => row);
}
