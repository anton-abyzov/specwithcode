/** The project's Scheduled tab: its routines, with run and pause in place. */
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

import { ProjectRoutines } from "../ProjectRoutines";
import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";

export function ScheduledPane(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectKey: string;
  canOperate: boolean;
  admissionBlocked: boolean;
  bar: ProjectPaneBarProps;
}) {
  return (
    <>
      <ProjectPaneBar {...props.bar} />
      <div
        className="sws-threads-body sws-scheduled"
        id="sws-pane-scheduled"
        role="tabpanel"
        aria-labelledby="sws-pane-tab-scheduled"
      >
        <ProjectRoutines
          environmentId={props.environmentId}
          projectId={props.projectId}
          projectKey={props.projectKey}
          canOperate={props.canOperate}
          admissionBlocked={props.admissionBlocked}
        />
      </div>
    </>
  );
}
