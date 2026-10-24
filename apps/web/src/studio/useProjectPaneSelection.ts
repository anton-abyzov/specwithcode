import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";

import { readThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import type { ProjectThreadOpenOptions } from "./projectMessageRouting";
import { isNestedSubagentThread, subagentHostThread } from "./threadSubagents";
import {
  paneSelectionCorrection,
  projectPaneThread,
  type ProjectPaneScope,
} from "./projectPaneThreads";

export interface SelectThreadOptions extends ProjectThreadOpenOptions {
  /** Replace the history entry: for corrections the user did not ask for. */
  readonly replace?: boolean;
  readonly environmentId?: EnvironmentId;
}
export type SelectProjectThread = (
  threadId: ThreadId | null,
  options?: SelectThreadOptions,
) => void;

/**
 * The thread open in a project's right panel: which shell it is, how a link opens
 * one there, and how a `?thread=` the panel cannot show is put right. The
 * project's coordinator never opens there: it is the main conversation, so a
 * link to it clears the panel's thread and shows the main conversation instead.
 */
export function useProjectPaneSelection(input: {
  readonly shells: readonly EnvironmentThreadShell[];
  readonly scope: ProjectPaneScope;
  readonly selected: ThreadId | null;
  readonly selectedEnvironmentId?: string | null;
  readonly restoringThread?: boolean;
  readonly setSelected: SelectProjectThread;
  readonly setOverviewOpen: (open: boolean) => void;
  /** Where to hand the keyboard back when the opened thread is left. */
  readonly lastOpened: RefObject<ThreadId | null>;
  /** Every host has answered and archived threads have loaded. */
  readonly threadsLoaded: boolean;
  /** Brings the main coordinator conversation into view, for a link that names it. */
  readonly onShowCoordinator: () => void;
  /**
   * A subagent never opens as a thread: a link to one opens the thread that
   * started it, with the subagent's transcript peeking over it.
   */
  readonly onPeekSubagent?: (hostThreadId: ThreadId, subagentThreadId: ThreadId) => void;
}) {
  const { shells, scope, selected, setSelected, threadsLoaded } = input;
  const navigate = useNavigate();
  // Subagents and forks of this project's threads open here too, whatever their project id.
  const decision = useMemo(
    () =>
      selected === null
        ? null
        : projectPaneThread(
            shells,
            scope,
            selected,
            input.selectedEnvironmentId ?? scope.environmentId,
          ),
    [scope, selected, shells, input.selectedEnvironmentId],
  );
  const coordinatorIds = useMemo(() => paneCoordinatorIds(scope), [scope]);
  // A `?thread=` naming a subagent shows the thread that started it.
  const subagentHost = useMemo(() => {
    if (decision?.kind !== "pane" || !isNestedSubagentThread(decision.thread, coordinatorIds))
      return null;
    const byId = new Map(
      shells
        .filter((shell) => shell.environmentId === decision.thread.environmentId)
        .map((shell) => [shell.id as string, shell]),
    );
    return {
      subagent: decision.thread,
      host: subagentHostThread(decision.thread, (id) => byId.get(id), coordinatorIds),
    };
  }, [decision, shells, coordinatorIds]);
  const selectedThread =
    decision?.kind !== "pane" ? null : subagentHost ? subagentHost.host : decision.thread;

  // A mirror of the latest input: the panel's routing value outlives renders
  // (toasts, awaited forks), and the timeline memoizes on a stable opener.
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Every thread of this project opens in the right panel; only another project's
  // thread (or one this client has not loaded) is left to open full page.
  const openThreadInPane = useCallback(
    (id: ThreadId, environmentId?: EnvironmentId, options?: ProjectThreadOpenOptions) => {
      // Once the project is left, a late caller opens the thread full page instead.
      if (!mounted.current) return false;
      const current = latest.current;
      // The store is read too: a thread started a moment ago may not have rendered here yet.
      const next = projectPaneThread(
        [...current.shells, ...readThreadShells()],
        current.scope,
        id,
        environmentId,
      );
      if (next.kind === "coordinator") {
        if (current.selected !== null) current.setSelected(null);
        current.onShowCoordinator();
        return true;
      }
      if (next.kind !== "pane") return false;
      const ids = paneCoordinatorIds(current.scope);
      if (isNestedSubagentThread(next.thread, ids)) {
        const all = [...current.shells, ...readThreadShells()].filter(
          (shell) => shell.environmentId === next.thread.environmentId,
        );
        const byId = new Map(all.map((shell) => [shell.id as string, shell]));
        const host = subagentHostThread(next.thread, (threadId) => byId.get(threadId), ids);
        if (host === null) return false;
        current.lastOpened.current = host.id;
        if (current.selected !== host.id)
          current.setSelected(host.id, { ...options, environmentId: host.environmentId });
        current.onPeekSubagent?.(host.id, next.thread.id);
        current.setOverviewOpen(true);
        return true;
      }
      current.lastOpened.current = id;
      if (next.thread.environmentId !== current.scope.environmentId || current.scope.members)
        current.setSelected(id, { ...options, environmentId: next.thread.environmentId });
      else if (options === undefined) current.setSelected(id);
      else current.setSelected(id, options);
      current.setOverviewOpen(true);
      return true;
    },
    [],
  );
  const openThread = useCallback(
    (id: ThreadId, environmentId?: EnvironmentId) => {
      if (!openThreadInPane(id, environmentId))
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(
              environmentId ?? (latest.current.scope.environmentId as EnvironmentId),
              id,
            ),
          ),
        });
    },
    [navigate, openThreadInPane],
  );

  // A link into this panel that names another project's thread opens it full page;
  // one naming the coordinator shows the main conversation; one naming a deleted or
  // never-loaded thread closes the panel. Both replace the
  // history entry, so Back does not land on the dead link again.
  const subagentHostId = subagentHost?.host?.id ?? null;
  const subagentHostEnvironment = subagentHost?.host?.environmentId ?? null;
  const peekedSubagentId = subagentHost?.subagent.id ?? null;
  useEffect(() => {
    if (subagentHostId === null || peekedSubagentId === null) return;
    setSelected(subagentHostId, {
      replace: true,
      ...(subagentHostEnvironment
        ? { environmentId: subagentHostEnvironment as EnvironmentId }
        : {}),
    });
    latest.current.onPeekSubagent?.(subagentHostId, peekedSubagentId);
  }, [peekedSubagentId, setSelected, subagentHostEnvironment, subagentHostId]);
  const correction = input.restoringThread
    ? !threadsLoaded
      ? { kind: "none" as const }
      : decision?.kind === "pane" && !decision.thread.archivedAt
        ? { kind: "none" as const }
        : { kind: "close" as const }
    : paneSelectionCorrection(decision, threadsLoaded);
  const correctionEnvironment = correction.kind === "elsewhere" ? correction.environmentId : null;
  useEffect(() => {
    if (selected === null || correction.kind === "none") return;
    if (correction.kind === "coordinator") {
      setSelected(null, { replace: true });
      latest.current.onShowCoordinator();
    } else if (correction.kind === "close") setSelected(null, { replace: true });
    else if (correctionEnvironment !== null)
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(correctionEnvironment as EnvironmentId, selected),
        ),
        replace: true,
      });
  }, [correction.kind, correctionEnvironment, navigate, selected, setSelected]);

  return { selectedThread, openThreadInPane, openThread };
}

/** The coordinators a project's panel knows: their workers are threads, not subagents. */
function paneCoordinatorIds(scope: ProjectPaneScope): ReadonlySet<string> {
  const ids = new Set<string>();
  if (scope.coordinatorThreadId) ids.add(scope.coordinatorThreadId);
  for (const member of scope.members ?? [])
    if (member.coordinatorThreadId) ids.add(member.coordinatorThreadId);
  return ids;
}
