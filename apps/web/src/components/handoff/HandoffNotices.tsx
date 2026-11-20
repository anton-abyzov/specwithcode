import { useAtomValue } from "@effect/atom-react";
import { attentionOwnerMachine } from "@specweave-studio/client-runtime/state/projectAttention";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ProjectId,
} from "@specweave-studio/contracts";
import {
  isDelegatedThread,
  projectAlertAllowed,
  projectNotificationLevel,
  type ProjectNotificationLevel,
} from "@specweave-studio/shared/projectNotifications";
import * as Option from "effect/Option";
import { FolderInputIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef } from "react";

import { useOpenChat } from "../../hooks/useOpenChat";
import { useClientSettings } from "../../hooks/useSettings";
import { backgroundActivityClientId } from "../../lib/backgroundActivityReporter";
import { notificationsConnected, useNotificationsConnected } from "../../notificationConnection";
import { deliverNotificationOnce } from "../../notificationHistory";
import {
  decideNotificationDelivery,
  ownerMachineReachable,
  readNotificationTarget,
} from "../../notificationTarget";
import { useProjects } from "../../state/entities";
import {
  useEnvironmentIds,
  usePrimaryEnvironmentId,
  useUnreachableEnvironmentIds,
} from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { currentRemoteWorkerLaunchers } from "../../studio/remoteWorkerLaunchers";
import { hasDesktopNotifications, isNotificationOwner } from "../../threadNotifications";
import { toastManager } from "../ui/toast";
import { observeHandoffNotices, type HandoffNotice } from "./handoffNotice.logic";

const TITLE_MAX = 256;

/**
 * One notification per automatic hand off on this machine (1390 AC-28): the
 * source when its thread gets the line, the destination when the continuation
 * arrives with it. It goes through the app's usual path: a toast in a focused
 * window, else the device the serving machine picks, and the project's level.
 * The source's copy is fenced, so the thread alerts in ThreadNotificationCoordinator
 * skip it; this reads the move links instead.
 */
export function HandoffNotices({ environmentId }: { environmentId: EnvironmentId }) {
  const connected = useNotificationsConnected();
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inApp = useClientSettings((settings) => settings.inAppNotificationsEnabled);
  const openChat = useOpenChat();
  const projects = useProjects();
  const ownEnvironmentId = usePrimaryEnvironmentId();
  const knownEnvironmentIds = useEnvironmentIds();
  const unreachableEnvironmentIds = useUnreachableEnvironmentIds();
  const latest = useRef({
    mode,
    inApp,
    levels: new Map<ProjectId, ProjectNotificationLevel>(),
    presence: { ownEnvironmentId, knownEnvironmentIds, unreachableEnvironmentIds },
  });
  useLayoutEffect(() => {
    latest.current = {
      mode,
      inApp,
      levels: new Map(
        projects
          .filter((project) => project.environmentId === environmentId)
          .map((project) => [project.id, projectNotificationLevel(project)]),
      ),
      presence: { ownEnvironmentId, knownEnvironmentIds, unreachableEnvironmentIds },
    };
  }, [
    environmentId,
    inApp,
    knownEnvironmentIds,
    mode,
    ownEnvironmentId,
    projects,
    unreachableEnvironmentIds,
  ]);
  const seen = useRef<ReturnType<typeof observeHandoffNotices>["seen"] | null>(null);
  const wasConnected = useRef(connected);

  useEffect(() => {
    // Like the thread alerts: after a reconnect, what is there is history.
    if (wasConnected.current !== connected) {
      seen.current = null;
      wasConnected.current = connected;
    }
    if (threads === null) return;
    const pass = observeHandoffNotices(seen.current, threads);
    seen.current = pass.seen;
    for (const { thread, notice } of pass.notices) {
      if (thread.archivedAt !== null || thread.deletedAt != null) continue;
      void deliver(thread, notice);
    }

    async function deliver(thread: OrchestrationV2ThreadShell, notice: HandoffNotice) {
      const allowed = () =>
        projectAlertAllowed(
          latest.current.levels.get(thread.projectId) ?? projectNotificationLevel(null),
          { delegated: isDelegatedThread(thread), needsYou: false },
        );
      if (!isNotificationOwner() || !allowed()) return;
      const eventKey = JSON.stringify([
        environmentId,
        thread.projectId,
        thread.id,
        "handoff",
        notice.identity,
      ]);
      const target = { environmentId, threadId: thread.id, projectId: thread.projectId };
      await deliverNotificationOnce(eventKey, async () => {
        if (!isNotificationOwner() || !allowed()) return false;
        const focused = document.visibilityState === "visible" && document.hasFocus();
        if (focused) {
          if (!latest.current.inApp) return false;
          const toastId = toastManager.add({
            type: "info",
            title: notice.title,
            description: notice.body,
            data: {
              hideCopyButton: true,
              leadingIcon: <FolderInputIcon aria-hidden className="size-4 text-info-foreground" />,
            },
            actionProps: {
              children: "Open thread",
              onClick: () => {
                toastManager.close(toastId);
                void openChat(target);
              },
            },
          });
          return true;
        }
        // The serving machine picks the one device that shows it.
        const read = await readNotificationTarget(environmentId);
        const { presence } = latest.current;
        const ownerMachineId = attentionOwnerMachine(
          { environmentId, id: thread.id, ownerMachineId: thread.ownerMachineId },
          currentRemoteWorkerLaunchers(),
        );
        const delivery = decideNotificationDelivery({
          read,
          ownClientId: backgroundActivityClientId(),
          ownEnvironmentId: presence.ownEnvironmentId,
          servingEnvironmentId: environmentId,
          ownerMachineId,
          ownerReachable: ownerMachineReachable(
            ownerMachineId,
            presence.knownEnvironmentIds,
            presence.unreachableEnvironmentIds,
          ),
        });
        // Another device shows it, or it only badges: handled, never retried.
        if (delivery !== "post") return true;
        if (!notificationsConnected() || !hasDesktopNotifications(latest.current.mode))
          return false;
        const name = thread.title.trim() || notice.title;
        const title = name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1)}…` : name;
        const tag = `${environmentId}:${thread.id}:handoff`;
        const bridge = window.desktopBridge;
        if (bridge?.showThreadNotification)
          return bridge
            .showThreadNotification({ tag, title, body: notice.body, target })
            .catch(() => false);
        if (typeof Notification === "undefined" || Notification.permission !== "granted")
          return false;
        try {
          const shown = new Notification(title, { body: notice.body, tag, silent: true });
          shown.addEventListener("click", () => {
            shown.close();
            window.focus();
            void openChat(target);
          });
          return true;
        } catch {
          return false;
        }
      });
    }
  }, [connected, environmentId, openChat, threads]);

  return null;
}
