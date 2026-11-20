/**
 * A coordinator message that carries a step for the person raises one desktop
 * notification on the receiving machine (1427 AC-19): "On <machine>: <step>",
 * from the sending coordinator, in this project. A message without a step, and a
 * merged repeat of one already shown, raise nothing.
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import {
  projectAlertAllowed,
  projectNotificationLevel,
} from "@specweave-studio/shared/projectNotifications";
import { useEffect, useRef } from "react";

import { useOpenChat } from "../hooks/useOpenChat";
import { getClientSettings } from "../hooks/useSettings";
import { useTx } from "../i18n";
import { notificationsConnected } from "../notificationConnection";
import { deliverNotificationOnce } from "../notificationHistory";
import { useProjects } from "../state/entities";
import {
  COORDINATOR_STEP_RECENT_MS,
  coordinatorStepEventKey,
  stepNotification,
  stepsToRaise,
} from "../studio/coordinatorMessages";
import { useMachineIdentities } from "../studio/machineIdentity";
import { useCoordinatorMessages } from "../studio/useCoordinatorMessages";
import { hasDesktopNotifications, isNotificationOwner } from "../threadNotifications";

export function CoordinatorStepNotifications({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const projects = useProjects();
  const linked = projects.filter(
    (project) =>
      project.environmentId === environmentId &&
      project.workspaceSettings?.logicalProject !== undefined &&
      projectNotificationLevel(project) !== "none",
  );
  return linked.map((project) => <ProjectStepNotifications key={project.id} project={project} />);
}

function ProjectStepNotifications({ project }: { readonly project: EnvironmentProject }) {
  const { list } = useCoordinatorMessages({
    environmentId: project.environmentId,
    projectId: project.id,
    enabled: true,
  });
  const tx = useTx();
  const identityOf = useMachineIdentities();
  const openChat = useOpenChat();
  const latest = useRef({ project, tx, identityOf, openChat });
  useEffect(() => {
    latest.current = { project, tx, identityOf, openChat };
  });
  const since = useRef(Date.now() - COORDINATOR_STEP_RECENT_MS);
  const raised = useRef(new Set<string>());

  useEffect(() => {
    for (const message of stepsToRaise(list, raised.current, since.current)) {
      raised.current.add(message.id);
      const step = message.userStep;
      if (step === undefined) continue;
      const environmentId = project.environmentId;
      void deliverNotificationOnce(coordinatorStepEventKey(environmentId, message.id), async () => {
        const { project: current, tx: say, identityOf: name, openChat: open } = latest.current;
        if (!isNotificationOwner() || !notificationsConnected()) return false;
        // A step is a request for the person: every level but "none" lets it through.
        if (
          !projectAlertAllowed(projectNotificationLevel(current), {
            delegated: false,
            needsYou: true,
          })
        )
          return true;
        if (!hasDesktopNotifications(getClientSettings().notificationMode)) return true;
        const { title, body } = stepNotification({
          step: step.text,
          stepMachine: name(step.environmentId).name,
          sender: name(message.peerEnvironmentId).name,
          project: current.title,
          tx: say,
        });
        const coordinatorThreadId = current.workspaceSettings?.coordinatorThreadId as
          | ThreadId
          | undefined;
        const tag = `coordinator-step:${environmentId}:${message.id}`;
        const bridge = window.desktopBridge;
        if (bridge?.showThreadNotification && coordinatorThreadId) {
          return bridge
            .showThreadNotification({
              tag,
              title,
              body,
              target: { environmentId, threadId: coordinatorThreadId, projectId: current.id },
            })
            .catch(() => false);
        }
        if (typeof Notification === "undefined" || Notification.permission !== "granted")
          return false;
        try {
          const notification = new Notification(title, { body, tag, silent: true });
          notification.addEventListener("click", () => {
            notification.close();
            window.focus();
            if (coordinatorThreadId)
              void open({ environmentId, threadId: coordinatorThreadId, projectId: current.id });
          });
          return true;
        } catch {
          return false;
        }
      });
    }
  }, [list, project.environmentId]);

  return null;
}
