/** The project's Routines tab: its routines, with run and pause in place. */
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";

import { ProjectRoutines } from "../ProjectRoutines";
import { ProjectPaneBar, type ProjectPaneBarProps } from "./ProjectPaneBar";

export function ScheduledPane(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectKey: string;
  canOperate: boolean;
  admissionBlocked: boolean;
  personal: boolean;
  modelSelection: ModelSelection | null;
  machineLabel: string | null;
  onOpenThread: (threadId: ThreadId) => void;
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
          personal={props.personal}
          modelSelection={props.modelSelection}
          machineLabel={props.machineLabel}
          onOpenThread={props.onOpenThread}
        />
      </div>
    </>
  );
}
