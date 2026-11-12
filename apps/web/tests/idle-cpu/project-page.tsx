/**
 * The project page's thread list, wired as the project page wires it: the project's
 * thread inventory, its attention summary and working subagents feed the real
 * Threads pane. The coordinator's conversation and composer are not mounted.
 */
import { useMemo, useRef, useState } from "react";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { ThreadId } from "@specweave-studio/contracts";
import { ThreadsPane } from "../../src/components/studio/shell/ThreadsPane";
import { useThreadSubagents } from "../../src/components/studio/shell/SubagentsChip";
import { listedRunningSubagents } from "../../src/studio/threadSubagents";
import { useProjectAttention } from "../../src/studio/useProjectAttention";
import { useProjectThreadInventory } from "../../src/studio/useProjectThreadInventory";
import { useUnreachableHosts } from "../../src/studio/unreachableHosts";

const noop = () => {};
export function ProjectPage({ project }: { project: EnvironmentProject }) {
  const coordinatorId = `project-coordinator:${project.id}` as ThreadId;
  const checkouts = useMemo(() => [project], [project]);
  const { executionScopes, shells, workers } = useProjectThreadInventory(
    project,
    checkouts,
    coordinatorId,
    true,
  );
  const attentionProjects = useMemo(
    () =>
      executionScopes.map((scope) => ({
        environmentId: scope.environmentId,
        id: scope.projectId,
        workspaceSettings: {
          logicalProject: project.workspaceSettings?.logicalProject,
          coordinatorThreadId: coordinatorId,
        },
      })),
    [executionScopes, project.workspaceSettings?.logicalProject, coordinatorId],
  );
  const attention = useProjectAttention(shells, attentionProjects);
  const coordinatorIds = useMemo(() => new Set<string>([coordinatorId]), [coordinatorId]);
  const unreachable = useUnreachableHosts();
  const subagents = useThreadSubagents({ thread: null, shells, coordinatorIds, unreachable });
  const runningSubagents = useMemo(
    () =>
      listedRunningSubagents({
        threads: workers,
        shells,
        coordinatorIds,
        unreachable,
        selected: null,
        selectedEntries: subagents,
      }),
    [coordinatorIds, shells, subagents, unreachable, workers],
  );
  const findRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [findOpen, setFindOpen] = useState(false);
  const waiting = attention.count;
  return (
    <aside
      className="project-thread-pane sws-threads h-screen min-w-0 flex-1 overflow-auto"
      data-project-pane="threads"
      data-waiting={waiting}
    >
      <ThreadsPane
        environmentId={project.environmentId}
        projectId={project.id}
        threadsLoaded
        threads={workers}
        attention={attention}
        runningSubagents={runningSubagents}
        canChange
        findRef={findRef}
        findOpen={findOpen}
        onFindOpenChange={setFindOpen}
        query={query}
        onQueryChange={setQuery}
        onOpen={noop}
        onToggleResolved={noop}
        bar={{
          tab: "threads",
          onTabChange: noop,
          counts: { threads: { value: waiting, label: "need you", tone: "waiting" } },
          onNewThread: noop,
          expanded: false,
          onToggleExpanded: noop,
          onClose: noop,
        }}
      />
    </aside>
  );
}
