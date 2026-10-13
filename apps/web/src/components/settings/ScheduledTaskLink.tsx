import { Link, useLocation } from "@tanstack/react-router";
import type { EnvironmentId, ScheduledTaskId } from "@specweave-studio/contracts";
import type { ReactNode } from "react";

/** Opens a task editor and retains the screen to return to when it is dismissed. */
export function ScheduledTaskLink({
  environmentId,
  taskId,
  children,
  className,
}: {
  environmentId: EnvironmentId;
  taskId: ScheduledTaskId;
  children: ReactNode;
  className?: string;
}) {
  const returnTo = useLocation({ select: (location) => location.href });
  return (
    <Link
      to="/settings/scheduled-tasks"
      search={{ environmentId, taskId, returnTo }}
      className={className}
    >
      {children}
    </Link>
  );
}
