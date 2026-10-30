import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { OrchestratorCopy } from "../../studio/projectCoordinatorMachine";
import { Button } from "../ui/button";
import { useStartCoordinator } from "./OrchestratorSwitcher";

/**
 * Why the coordinator composer cannot send. A workers-only copy whose
 * coordinator runs on another machine also offers the way out: open that
 * coordinator, where work for this copy is started, or start a coordinator on
 * this copy through the switcher's own start action.
 */
export function CoordinatorBlockedNotice({
  text,
  coordinator,
  current,
  members,
  copies,
  onOpen,
}: {
  text: string;
  /** The checkout that starts work for this workers-only copy; null for any other reason. */
  coordinator: { readonly key: string; readonly machine: string | null } | null;
  /** This page's checkout key. */
  current: string;
  members: readonly EnvironmentProject[];
  copies: readonly OrchestratorCopy[];
  /** Shows another checkout's orchestrator; null until saved choices load. */
  onOpen: ((key: string) => void) | null;
}) {
  const start = useStartCoordinator(members, copies);
  const here = copies.find((copy) => copy.key === current);
  if (!coordinator)
    return (
      <p className="project-muted" role="status">
        {text}
      </p>
    );
  return (
    <div className="project-muted" role="status" data-workers-only={coordinator.key}>
      <p>{text}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {onOpen ? (
          <Button variant="outline" size="xs" onClick={() => onOpen(coordinator.key)}>
            {coordinator.machine
              ? `Open ${coordinator.machine}'s coordinator`
              : "Open the coordinator"}
          </Button>
        ) : null}
        {here?.canStart ? (
          <Button variant="ghost" size="xs" onClick={() => void start(here.key)}>
            Start a coordinator on {here.machine}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
