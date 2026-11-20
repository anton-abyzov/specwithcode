/**
 * A coordinator message that carries a step for the person raises one
 * notification on the receiving machine (1427 AC-19): "On <machine>: <step>",
 * from the sending coordinator, in this project. It goes the app's usual way:
 * a toast and the input sound in a focused window, else the device the serving
 * machine picks. A message without a step, and a merged repeat of one already
 * shown, raise nothing. A step counts as raised only once it was delivered or
 * deliberately skipped, so a failed attempt is retried on the next read.
 */
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import {
  projectAlertAllowed,
  projectNotificationLevel,
} from "@specweave-studio/shared/projectNotifications";
import { MessagesSquareIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { useOpenChat } from "../hooks/useOpenChat";
import { getClientSettings } from "../hooks/useSettings";
import { useTx } from "../i18n";
import { backgroundActivityClientId } from "../lib/backgroundActivityReporter";
import { notificationsConnected } from "../notificationConnection";
import { deliverNotificationOnce } from "../notificationHistory";
import {
  decideNotificationDelivery,
  ownerMachineReachable,
  readNotificationTarget,
} from "../notificationTarget";
import { useProjects } from "../state/entities";
import {
  useEnvironmentIds,
  usePrimaryEnvironmentId,
  useUnreachableEnvironmentIds,
} from "../state/environments";
import {
  COORDINATOR_STEP_RECENT_MS,
  coordinatorStepEventKey,
  stepNotification,
  stepsToRaise,
} from "../studio/coordinatorMessages";
import { useMachineIdentities } from "../studio/machineIdentity";
import { useCoordinatorMessages } from "../studio/useCoordinatorMessages";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  isNotificationOwner,
  playNotificationSound,
} from "../threadNotifications";
import { toastManager } from "./ui/toast";

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

function playStepSound() {
  void playNotificationSound("input", () =>
    hasNotificationSound(getClientSettings().notificationMode),
  );
}

function ProjectStepNotifications({ project }: { readonly project: EnvironmentProject }) {
  const { list } = useCoordinatorMessages({
    environmentId: project.environmentId,
    projectId: project.id,
    enabled: true,
    background: true,
  });
  const tx = useTx();
  const identityOf = useMachineIdentities();
  const openChat = useOpenChat();
  const ownEnvironmentId = usePrimaryEnvironmentId();
  const knownEnvironmentIds = useEnvironmentIds();
  const unreachableEnvironmentIds = useUnreachableEnvironmentIds();
  const latest = useRef({
    project,
    tx,
    identityOf,
    openChat,
    presence: { ownEnvironmentId, knownEnvironmentIds, unreachableEnvironmentIds },
  });
  useEffect(() => {
    latest.current = {
      project,
      tx,
      identityOf,
      openChat,
      presence: { ownEnvironmentId, knownEnvironmentIds, unreachableEnvironmentIds },
    };
  });
  const since = useRef(Date.now() - COORDINATOR_STEP_RECENT_MS);
  // Handled steps: delivered, or deliberately not shown here. In-flight ones are
  // skipped too, so a slow delivery is not started twice.
  const raised = useRef(new Set<string>());
  const inFlight = useRef(new Set<string>());
  // An unmounted notifier shows nothing; the step stays unhandled for the next one.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const busy = new Set([...raised.current, ...inFlight.current]);
    for (const message of stepsToRaise(list, busy, since.current)) {
      const step = message.userStep;
      if (step === undefined) continue;
      const stepText = step.text;
      const stepEnvironmentId = step.environmentId;
      const environmentId = project.environmentId;
      inFlight.current.add(message.id);
      let handled = true;
      void deliverNotificationOnce(coordinatorStepEventKey(environmentId, message.id), async () => {
        handled = await deliver();
        return handled;
      })
        .catch(() => {
          handled = false;
        })
        .finally(() => {
          inFlight.current.delete(message.id);
          if (handled) raised.current.add(message.id);
        });

      async function deliver(): Promise<boolean> {
        const { project: current, tx: say, identityOf: name, openChat: open } = latest.current;
        if (!mounted.current || !isNotificationOwner() || !notificationsConnected()) return false;
        // A step is a request for the person: every level but "none" lets it through.
        if (
          !projectAlertAllowed(projectNotificationLevel(current), {
            delegated: false,
            needsYou: true,
          })
        )
          return true;
        const { title, body } = stepNotification({
          step: stepText,
          stepMachine: name(stepEnvironmentId).name,
          sender: name(message.peerEnvironmentId).name,
          project: current.title,
          tx: say,
        });
        const coordinatorThreadId = current.workspaceSettings?.coordinatorThreadId as
          | ThreadId
          | undefined;
        const target = coordinatorThreadId
          ? { environmentId, threadId: coordinatorThreadId, projectId: current.id }
          : null;
        // The serving machine picks the one device that pops it up and plays it;
        // a focused window on the receiving machine shows it as a toast.
        const read = await readNotificationTarget(environmentId);
        if (!mounted.current) return false;
        const { presence } = latest.current;
        const delivery = decideNotificationDelivery({
          read,
          ownClientId: backgroundActivityClientId(),
          ownEnvironmentId: presence.ownEnvironmentId,
          servingEnvironmentId: environmentId,
          ownerMachineId: environmentId,
          ownerReachable: ownerMachineReachable(
            environmentId,
            presence.knownEnvironmentIds,
            presence.unreachableEnvironmentIds,
          ),
        });
        const focused = document.visibilityState === "visible" && document.hasFocus();
        if (focused && (delivery === "post" || presence.ownEnvironmentId === environmentId)) {
          // Toasts are off here: a deliberate skip, never retried.
          if (!getClientSettings().inAppNotificationsEnabled) return true;
          const toastId = toastManager.add({
            type: "info",
            title,
            description: body,
            data: {
              hideCopyButton: true,
              leadingIcon: (
                <MessagesSquareIcon aria-hidden className="size-4 text-info-foreground" />
              ),
            },
            ...(target
              ? {
                  actionProps: {
                    children: say("Open coordinator", {}),
                    onClick: () => {
                      toastManager.close(toastId);
                      void open(target);
                    },
                  },
                }
              : {}),
          });
          // Only the device the serving machine picked plays the sound, so it plays once.
          if (delivery === "post") playStepSound();
          return true;
        }
        // Another device shows it, or it only badges: handled, never retried.
        if (delivery !== "post") return true;
        const settings = getClientSettings();
        const mode = settings.notificationMode;
        // A step asks for the person, so "Alert when input is needed" lets it through too.
        if (!hasDesktopNotifications(mode) && settings.inputNeededAlertsEnabled !== true) {
          if (!hasNotificationSound(mode)) return true;
          playStepSound();
          return true;
        }
        const tag = `coordinator-step:${environmentId}:${message.id}`;
        const bridge = window.desktopBridge;
        if (bridge?.showThreadNotification && target) {
          const shown = await bridge
            .showThreadNotification({ tag, title, body, target })
            .catch(() => false);
          if (shown) playStepSound();
          return shown;
        }
        if (typeof Notification === "undefined" || Notification.permission !== "granted")
          return false;
        try {
          const notification = new Notification(title, { body, tag, silent: true });
          notification.addEventListener("click", () => {
            notification.close();
            window.focus();
            if (target) void open(target);
          });
          playStepSound();
          return true;
        } catch {
          return false;
        }
      }
    }
  }, [list, project.environmentId]);

  return null;
}
