import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { cn } from "../../../lib/utils";
import { driverLabel } from "../usageScope";
import { deliveredCostText } from "./deliveredReport";
import {
  BINDING_LABEL,
  isWeakBinding,
  stateLabel,
  type DeliveredView,
  type MergedGroup,
  type MergedIncrement,
  type MergedThread,
} from "./usageDeliveredMerge";

const STATE_CLASS: Record<MergedIncrement["state"], string> = {
  closed: "border-success/40 bg-success/8 text-success-foreground",
  merged: "border-primary/30 bg-primary/8 text-primary",
  in_progress: "border-border bg-muted/50 text-muted-foreground",
};
const ROWS_SHOWN = 25;

function Detail({ increment }: { readonly increment: MergedIncrement }) {
  return (
    <div className="grid gap-6 py-2 ps-6 text-xs md:grid-cols-[1fr_1.4fr]">
      <div className="flex flex-col gap-1">
        <h4 className="font-medium text-muted-foreground">By provider and model</h4>
        {increment.byModel.map((entry) => (
          <div
            key={`${entry.driver}:${entry.model}`}
            className="flex justify-between gap-3 border-b border-dashed border-border/70 py-1"
          >
            <span className="min-w-0 truncate">
              {driverLabel(entry.driver)} · {entry.model}
            </span>
            <span className="tabular-nums">{deliveredCostText(entry)}</span>
          </div>
        ))}
      </div>
      <ThreadList
        threads={increment.threads}
        more={increment.threadCount - increment.threads.length}
      />
    </div>
  );
}

function ThreadList({
  threads,
  more,
}: {
  readonly threads: readonly MergedThread[];
  readonly more: number;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h4 className="font-medium text-muted-foreground">Threads</h4>
      {threads.map((thread) => (
        <div
          key={`${thread.machine}:${thread.threadId}`}
          className="flex justify-between gap-3 border-b border-dashed border-border/70 py-1"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{thread.title ?? "Untitled thread"}</span>
            <span className="shrink-0 text-muted-foreground">· {thread.machine}</span>
            {thread.binding === null ? null : (
              <span
                className={cn(
                  "shrink-0 rounded border px-1 text-2xs",
                  isWeakBinding(thread.binding)
                    ? "border-warning/40 text-warning-foreground"
                    : "border-border text-muted-foreground",
                )}
              >
                {BINDING_LABEL[thread.binding]}
              </span>
            )}
          </span>
          <span className="tabular-nums">{deliveredCostText(thread.cost)}</span>
        </div>
      ))}
      {more > 0 ? <span className="py-1 text-muted-foreground">+ {more} more threads</span> : null}
    </div>
  );
}

function GroupRow({
  label,
  note,
  group,
}: {
  readonly label: string;
  readonly note: string;
  readonly group: MergedGroup;
}) {
  return (
    <tr className="border-b border-border/50 align-top text-foreground/90">
      <td className="py-2 pe-3 font-medium">{label}</td>
      <td className="py-2 pe-3 text-xs text-muted-foreground" colSpan={2}>
        {note}
      </td>
      <td className="py-2 pe-3 text-right tabular-nums">
        {group.threadCount === 0 ? "—" : group.threadCount}
      </td>
      <td className="py-2 pe-3 text-xs">{group.byModel[0]?.model ?? "—"}</td>
      <td className="py-2 text-right tabular-nums">{deliveredCostText(group.cost)}</td>
    </tr>
  );
}

/** Increments by cost, each expandable to its models and threads, then the rows that belong to none. */
export function DeliveredTable({
  view,
  formatDay,
}: {
  readonly view: DeliveredView;
  readonly formatDay: (iso: string) => string;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const top = view.increments[0]?.cost.costUsd ?? 0;
  const shown = showAll ? view.increments : view.increments.slice(0, ROWS_SHOWN);
  const hidden = view.increments.slice(shown.length);
  const largestOther = view.otherThreads.threads
    .slice(0, 3)
    .map((thread) => `${thread.title ?? "Untitled"} ${deliveredCostText(thread.cost)}`)
    .join(" · ");
  return (
    <section className="flex flex-col gap-2" aria-label="Increments">
      <h2 className="text-sm font-medium text-foreground">Increments</h2>
      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col className="w-[38%]" />
          <col className="w-[14%]" />
          <col className="w-[10%]" />
          <col className="w-[8%]" />
          <col className="w-[14%]" />
          <col className="w-[16%]" />
        </colgroup>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="py-2 font-normal">Increment</th>
            <th className="py-2 font-normal">Status</th>
            <th className="py-2 text-right font-normal">Tasks done</th>
            <th className="py-2 text-right font-normal">Threads</th>
            <th className="py-2 ps-3 font-normal">Top model</th>
            <th className="py-2 text-right font-normal">Cost</th>
          </tr>
        </thead>
        <tbody>
          {view.increments.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-6 text-center text-muted-foreground">
                No increment had spend, finished tasks, a merge or a closure in this range.
              </td>
            </tr>
          ) : null}
          {shown.map((increment) => {
            const expanded = open.has(increment.key);
            return (
              <Fragment key={increment.key}>
                <tr
                  className={cn("border-b border-border/50 align-top", expanded && "bg-muted/30")}
                >
                  <td className="py-2 pe-3">
                    <button
                      type="button"
                      aria-expanded={expanded}
                      className="flex min-w-0 items-start gap-1 text-left"
                      onClick={() =>
                        setOpen((current) => {
                          const next = new Set(current);
                          if (!next.delete(increment.key)) next.add(increment.key);
                          return next;
                        })
                      }
                    >
                      {expanded ? (
                        <ChevronDownIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      ) : (
                        <ChevronRightIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      )}
                      <span className="min-w-0">
                        <span className="me-1.5 text-xs text-muted-foreground tabular-nums">
                          {increment.number}
                        </span>
                        <span className="font-medium">{increment.title}</span>
                        {view.projects.length > 1 ? (
                          <span className="ms-1.5 text-xs text-muted-foreground">
                            {increment.project}
                          </span>
                        ) : null}
                        {increment.startedBeforeRange ? (
                          <span className="block text-xs text-warning-foreground">
                            Spend before this range not shown
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </td>
                  <td className="py-2 pe-3">
                    <span
                      className={cn(
                        "rounded-md border px-1.5 py-0.5 text-2xs whitespace-nowrap",
                        STATE_CLASS[increment.state],
                      )}
                    >
                      {stateLabel(increment, formatDay)}
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {increment.tasks.doneInRange} of {increment.tasks.total}
                  </td>
                  <td className="py-2 text-right tabular-nums">{increment.threadCount}</td>
                  <td className="truncate py-2 ps-3 text-xs">
                    {increment.byModel[0]?.model ?? "—"}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {deliveredCostText(increment.cost)}
                    <span
                      className="mt-1 block h-1 overflow-hidden rounded-full bg-muted"
                      aria-hidden
                    >
                      <span
                        className="block h-full bg-primary/70"
                        style={{
                          width: top > 0 ? `${(increment.cost.costUsd / top) * 100}%` : "0%",
                        }}
                      />
                    </span>
                  </td>
                </tr>
                {expanded ? (
                  <tr className="border-b border-border/50 bg-muted/30">
                    <td colSpan={6}>
                      <Detail increment={increment} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
          {hidden.length > 0 ? (
            <tr className="border-b border-border/50">
              <td colSpan={5} className="py-2">
                <button
                  type="button"
                  className="text-xs text-muted-foreground underline"
                  onClick={() => setShowAll(true)}
                >
                  + {hidden.length} more increments
                </button>
              </td>
              <td className="py-2 text-right text-muted-foreground tabular-nums">
                {deliveredCostText(
                  hidden.reduce(
                    (sum, increment) => ({
                      costUsd: sum.costUsd + increment.cost.costUsd,
                      tokens: sum.tokens + increment.cost.tokens,
                      records: sum.records + increment.cost.records,
                      unpricedRecords: sum.unpricedRecords + increment.cost.unpricedRecords,
                    }),
                    { costUsd: 0, tokens: 0, records: 0, unpricedRecords: 0 },
                  ),
                )}
              </td>
            </tr>
          ) : null}
          {view.groupsHidden ? (
            <tr>
              <td colSpan={6} className="py-3 text-xs text-muted-foreground">
                Coordinators, other threads and use outside the app carry no project, so a project
                filter leaves them out.
              </td>
            </tr>
          ) : (
            <>
              <GroupRow
                label="Coordinators"
                note="Project and machine coordinators, never spread over increments"
                group={view.coordinators}
              />
              <GroupRow
                label="Other threads"
                note={
                  largestOther === "" ? "Threads tied to no increment" : `Largest: ${largestOther}`
                }
                group={view.otherThreads}
              />
              <GroupRow
                label="Outside the app"
                note="Sessions started outside SpecWithCode on these machines"
                group={view.outsideApp}
              />
            </>
          )}
        </tbody>
      </table>
    </section>
  );
}
