import type { EnvironmentId } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { isElectron } from "../env";
import { useEnvironmentShellLive } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useMachineNicknames } from "../studio/machineNickname";
import { checkoutUnavailableReason } from "../studio/projectCoordinatorMachine";
import {
  THREAD_ROUTE_GRACE_MS,
  THREAD_ROUTE_SLOW_MS,
  threadRouteProblem,
} from "../studio/threadRouteProblem";
import { useUnreachableHosts } from "../studio/unreachableHosts";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/** A thread's page with no conversation to show: why, and the way back. */
export function ThreadRouteProblem(props: {
  environmentId: EnvironmentId;
  state: "missing" | "loading";
  deleted: boolean;
}) {
  const { environments } = useEnvironments();
  const unreachable = useUnreachableHosts();
  const projectsLive = useEnvironmentShellLive(props.environmentId);
  const nickname = useMachineNicknames();
  const [waitedMs, setWaitedMs] = useState(0);
  useEffect(() => {
    const timers = [THREAD_ROUTE_GRACE_MS, THREAD_ROUTE_SLOW_MS].map((ms) =>
      setTimeout(() => setWaitedMs(ms), ms),
    );
    return () => timers.forEach(clearTimeout);
  }, []);
  const label = environments.find((item) => item.environmentId === props.environmentId)?.label;
  const name = nickname(props.environmentId, label);
  const problem = threadRouteProblem({
    state: props.state,
    deleted: props.deleted,
    host: checkoutUnavailableReason({
      environmentId: props.environmentId,
      environments,
      unreachable,
      projectsLive,
    }),
    machine: label || name !== props.environmentId ? name : null,
    waitedMs,
  });
  const opening = problem.kind === "opening";
  return (
    <div
      className="project-surface flex min-h-0 flex-1 flex-col"
      data-thread-route-problem={problem.kind}
      aria-busy={opening}
    >
      <WorkspacePageHeader electron={isElectron}>Thread</WorkspacePageHeader>
      <div className="project-empty" role={opening ? "status" : "alert"}>
        {opening ? <p>{problem.title}</p> : <h1>{problem.title}</h1>}
        {problem.detail === null ? null : <p>{problem.detail}</p>}
        {opening ? null : <Link to="/">Back to Overview</Link>}
      </div>
    </div>
  );
}
