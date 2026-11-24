import type { UsageDeliveredCost } from "@specweave-studio/contracts";
import { formatPercent, formatTokens, formatUsd } from "@specweave-studio/shared/usageFormat";

import { costText } from "../usageFilters";
import { stateLabel, type DeliveredView, type MergedGroup } from "./usageDeliveredMerge";

/** A cost that never shows unknown as zero. */
export function deliveredCostText(cost: UsageDeliveredCost): string {
  return costText(cost).text;
}

function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function topModel(models: readonly { readonly model: string }[]): string {
  return models[0]?.model ?? "—";
}

/**
 * The Delivered tab as Markdown (1456): range, filters, the strip, every
 * increment and the four rows that belong to no increment. API-equivalent
 * cost, never a bill.
 */
export function deliveredReportMarkdown(input: {
  readonly view: DeliveredView;
  readonly rangeLabel: string;
  readonly filters: readonly string[];
  readonly formatDay: (iso: string) => string;
}): string {
  const { view } = input;
  const line = (cells: readonly string[]) => `| ${cells.map(cell).join(" | ")} |`;
  const share =
    view.measured.costUsd > 0 && !view.groupsHidden
      ? ` (${formatPercent(view.attributed.costUsd / view.measured.costUsd)} of ${deliveredCostText(view.measured)} measured)`
      : "";
  const lines = [
    "# What the usage delivered",
    "",
    `Range: ${input.rangeLabel}. Filters: ${input.filters.length === 0 ? "none" : input.filters.join("; ")}.`,
    "API-equivalent estimate, not a bill.",
    "",
    `- Tied to increments: ${deliveredCostText(view.attributed)}${share}`,
    `- Delivered (closed or merged in range): ${view.deliveredCount}`,
    `- Tasks done: ${view.tasksDone} across ${view.incrementsWithTasksDone} increments`,
    `- Median per delivered increment: ${view.medianDeliveredUsd === null ? "—" : formatUsd(view.medianDeliveredUsd)}`,
    "",
    line([
      "Increment",
      "Project",
      "Status",
      "Tasks done",
      "Threads",
      "Top model",
      "Tokens",
      "Cost",
    ]),
    line(["---", "---", "---", "---:", "---:", "---", "---:", "---:"]),
    ...view.increments.map((increment) =>
      line([
        `${increment.number} ${increment.title}${increment.startedBeforeRange ? " (earlier spend not shown)" : ""}`,
        increment.project,
        stateLabel(increment, input.formatDay),
        `${increment.tasks.doneInRange} of ${increment.tasks.total}`,
        String(increment.threadCount),
        topModel(increment.byModel),
        formatTokens(increment.cost.tokens),
        deliveredCostText(increment.cost),
      ]),
    ),
  ];
  if (!view.groupsHidden) {
    const row = (label: string, group: MergedGroup) =>
      line([
        label,
        "",
        "",
        "",
        group.threadCount === 0 ? "—" : String(group.threadCount),
        topModel(group.byModel),
        formatTokens(group.cost.tokens),
        deliveredCostText(group.cost),
      ]);
    lines.push(
      row("Coordinators", view.coordinators),
      row("Other threads", view.otherThreads),
      row("Outside the app", view.outsideApp),
    );
  } else {
    lines.push(
      "",
      "Coordinators, other threads and use outside the app carry no project, so a project filter leaves them out.",
    );
  }
  if (view.cursorHistoryExcluded) {
    lines.push(
      "",
      "Cursor's account history is left out: it is tied to no thread and is the same on every machine.",
    );
  }
  if (view.overlaps.length > 0) {
    lines.push(
      "",
      `May count twice: ${view.overlaps.map(([left, right]) => `${left} and ${right}`).join("; ")} read some of the same transcript folders.`,
    );
  }
  if (view.missing.length > 0) {
    lines.push(
      "",
      `Incomplete: ${view.missing.map((machine) => `${machine.name} ${machine.reason}`).join("; ")}.`,
    );
  }
  lines.push(
    "",
    "A thread counts toward one increment: linked by hand, claim, branch, checkpoint or title, else its parent thread's increment.",
  );
  return `${lines.join("\n")}\n`;
}
