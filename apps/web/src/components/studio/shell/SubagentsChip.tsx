/**
 * A thread's subagents, kept out of the thread list: one chip in the header
 * ("3 subagents", with a pulse while any works) opening a popover with a row
 * per subagent. A row opens that subagent's transcript in a read-only peek.
 */
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { ThreadId } from "@specweave-studio/contracts";
import { BotIcon, ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useNowMinute } from "../../../hooks/useNowMinute";
import { useThreadProjection } from "../../../state/entities";
import {
  firstLine,
  groupSubagentPopupEntries,
  workingSubagentEntryCount,
  isSubagentEntryActive,
  subagentEntryLabel,
  subagentStatusTone,
  threadSubagentEntries,
  threadWorkflowEntries,
  type SubagentEntry,
} from "../../../studio/threadSubagents";
import { AgentElapsed } from "../../chat/AgentElapsed";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { ModelBadge, useProviderEntriesByEnvironment } from "./ModelBadge";

const NO_SUBAGENTS: SubagentEntry[] = [];

export function useThreadSubagents(input: {
  readonly thread: Pick<EnvironmentThreadShell, "id" | "environmentId"> | null;
  readonly shells: readonly EnvironmentThreadShell[];
  readonly coordinatorIds: ReadonlySet<string>;
  readonly unreachable?: ReadonlySet<string> | undefined;
}): SubagentEntry[] {
  const environmentId = input.thread?.environmentId ?? null;
  const threadId = input.thread?.id ?? null;
  const ref = useMemo(
    () =>
      environmentId === null || threadId === null ? null : scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const projection = useThreadProjection(ref)?.projection;
  const projected = projection?.subagents;
  const turnItems = projection?.turnItems;
  const providerThreads = projection?.providerThreads;
  return useMemo(() => {
    if (environmentId === null || threadId === null) return NO_SUBAGENTS;
    const subagents = threadSubagentEntries({
      parent: { environmentId, id: threadId },
      projected: projected ?? [],
      shells: input.shells,
      coordinatorIds: input.coordinatorIds,
      unreachable: input.unreachable,
    });
    // Workflows are this thread's own work too: they list here, never as threads.
    const workflows = threadWorkflowEntries({
      parentThreadId: threadId,
      turnItems: turnItems ?? [],
      pendingBackgroundTasks: (providerThreads ?? [])
        .filter(
          (providerThread) =>
            providerThread.appThreadId == null || providerThread.appThreadId === threadId,
        )
        .flatMap((providerThread) => providerThread.pendingBackgroundTasks ?? []),
    });
    return workflows.length === 0
      ? subagents.length === 0
        ? NO_SUBAGENTS
        : subagents
      : [...workflows, ...subagents];
  }, [
    environmentId,
    threadId,
    projected,
    turnItems,
    providerThreads,
    input.shells,
    input.coordinatorIds,
    input.unreachable,
  ]);
}

export function SubagentsChip(props: {
  readonly environmentId: string;
  readonly entries: readonly SubagentEntry[];
  readonly onPeek: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const grouped = groupSubagentPopupEntries(props.entries, now);
  const entriesByEnvironment = useProviderEntriesByEnvironment();
  const providerEntries = entriesByEnvironment.get(props.environmentId);
  const total = props.entries.length;
  // A subagent blocked on the person is waiting, not working.
  const running = workingSubagentEntryCount(props.entries);
  const summary = [
    running > 0 ? `${running} working` : null,
    ...(
      [
        ["pending", "queued"],
        ["waiting", "waiting on work"],
        ["completed", "completed"],
        ["failed", "failed"],
        ["cancelled", "stopped"],
        ["interrupted", "interrupted"],
        ["unknown", "unknown"],
      ] as const
    ).map(([status, label]) => {
      const count = props.entries.filter(
        (entry) =>
          entry.status === status && (status !== "waiting" || entry.awaitingPerson === undefined),
      ).length;
      return count > 0 ? `${count} ${label}` : null;
    }),
    props.entries.some((entry) => entry.awaitingPerson !== undefined)
      ? `${props.entries.filter((entry) => entry.awaitingPerson !== undefined).length} need your input`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (total === 0) return null;
  const workflows = props.entries.filter((entry) => entry.kind === "workflow").length;
  const agents = total - workflows;
  const noun = countNoun(agents, workflows);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="sws-chip sws-subagents-chip"
        data-running={running > 0 ? "true" : undefined}
        aria-label={summary ? `${noun}, ${summary}` : noun}
      >
        <BotIcon aria-hidden />
        {total}
        <span className="sr-only">
          {workflows === 0 ? ` ${agents === 1 ? "subagent" : "subagents"}` : ` (${noun})`}
        </span>
        {running > 0 ? <span className="sws-dot" data-tone="working" aria-hidden /> : null}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="start" width="lg" padding="none">
        <div className="sws-subagents-popover">
          <header>
            <strong>{noun}</strong>
            {summary ? <span>{summary}</span> : null}
          </header>
          <p className="sws-subagents-scope">
            This thread’s subtree · all runs. Recent: last 30 minutes.
          </p>
          <div className="sws-subagents-sections">
            {(["current", "history"] as const).map((section) => {
              const entries = grouped[section];
              const rows = (
                <ul aria-label={section === "current" ? "Subagents" : "Subagent history"}>
                  {entries.map((entry) => {
                    const tone = subagentStatusTone(entry.status);
                    const line =
                      firstLine(entry.result) ??
                      (isSubagentEntryActive(entry) ? firstLine(entry.prompt) : null);
                    const providerEntry =
                      entry.providerInstanceId === null
                        ? null
                        : (providerEntries?.get(entry.providerInstanceId) ?? null);
                    const body = (
                      <>
                        <span className="sws-dot" data-tone={tone} aria-hidden />
                        <span className="sws-subagent-text">
                          <span className="sws-subagent-title">{entry.title}</span>
                          <span className="sws-subagent-meta">
                            {entry.kind === "workflow" ? (
                              <span className="sws-subagent-kind">
                                <WorkflowIcon aria-hidden className="size-3" /> Workflow
                              </span>
                            ) : null}
                            <span data-tone={tone}>{subagentEntryLabel(entry)}</span>
                            {entry.providerInstanceId && entry.model ? (
                              <ModelBadge
                                entry={providerEntry}
                                instanceId={entry.providerInstanceId}
                                model={entry.model}
                              />
                            ) : null}
                            {/* An unreachable child's clock would only count since it was last heard. */}
                            {entry.startedAt && entry.status !== "unknown" ? (
                              <AgentElapsed
                                agent={{
                                  status: entry.status,
                                  startedAt: entry.startedAt,
                                  completedAt: entry.completedAt,
                                }}
                              />
                            ) : null}
                          </span>
                          {line ? <span className="sws-subagent-result">{line}</span> : null}
                        </span>
                        {entry.childThreadId ? (
                          <ChevronRightIcon aria-hidden className="sws-subagent-open" />
                        ) : null}
                      </>
                    );
                    return (
                      <li key={entry.key} style={{ paddingInlineStart: entry.depth * 14 }}>
                        {entry.childThreadId ? (
                          <button
                            type="button"
                            className="sws-subagent-row"
                            onClick={() => {
                              setOpen(false);
                              props.onPeek(entry.childThreadId!);
                            }}
                          >
                            {body}
                          </button>
                        ) : (
                          <div className="sws-subagent-row">{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              );
              return section === "history" ? (
                entries.length > 0 ? (
                  <details key={section} data-subagent-history>
                    <summary>History · {entries.length}</summary>
                    {rows}
                  </details>
                ) : null
              ) : (
                <section key={section} aria-label="Current and recent subagents">
                  <h3>Current and recent · {entries.length}</h3>
                  {entries.length ? rows : <p>No current or recent work.</p>}
                </section>
              );
            })}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** "3 subagents", "1 workflow", "1 workflow, 4 subagents": the chip's count, spelled out. */
function countNoun(agents: number, workflows: number): string {
  const parts = [
    workflows > 0 ? `${workflows} ${workflows === 1 ? "workflow" : "workflows"}` : null,
    agents > 0 ? `${agents} ${agents === 1 ? "subagent" : "subagents"}` : null,
  ].filter((part): part is string => part !== null);
  return parts.join(", ");
}
