import { presentThreadShell } from "@specweave-studio/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { useParams } from "@tanstack/react-router";
import type {
  EnvironmentId,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { useOpenChat } from "../hooks/useOpenChat";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  isNotificationOwner,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import { useProjectPaneThreadParam } from "../studio/useProjectPaneThreadParam";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { toastManager } from "./ui/toast";

/** A system notification still on screen, until the user comes back. */
// The desktop bridge accepts notification titles up to 256 characters.
const SYSTEM_TITLE_MAX_LENGTH = 256;

interface ShownNotification {
  readonly environmentId: EnvironmentId;
  readonly close: () => void;
}

/** Records a shown notification, or forgets it with `posted` false when the system declined it. */
type OnNotification = (tag: string, shown: ShownNotification, posted?: boolean) => void;

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const inputNeededAlertsEnabled = useClientSettings(
    (settings) => settings.inputNeededAlertsEnabled === true,
  );
  // A project workspace's thread opens in that project's right panel.
  const openChat = useOpenChat();
  const pending = useRef(new Map<string, ShownNotification>());
  const onNotification = useCallback<OnNotification>((tag, shown, posted = true) => {
    const previous = pending.current.get(tag);
    if (!posted) {
      if (previous !== shown) return;
      pending.current.delete(tag);
    } else {
      if (previous && previous !== shown) previous.close();
      pending.current.set(tag, shown);
    }
    setNotificationBadge(pending.current.size);
  }, []);

  useEffect(() => {
    const activeIds = new Set(environmentIds);
    const count = pending.current.size;
    for (const [tag, { environmentId, close }] of pending.current) {
      if (activeIds.has(environmentId)) continue;
      close();
      pending.current.delete(tag);
    }
    if (count !== pending.current.size) setNotificationBadge(pending.current.size);
  }, [environmentIds]);

  // A native notification clicked while the app was in the background: the
  // shell has already brought this window forward.
  useEffect(
    () =>
      window.desktopBridge?.onThreadNotificationOpen?.(({ environmentId, threadId }) => {
        void openChat({
          environmentId: environmentId as EnvironmentId,
          threadId: threadId as ThreadId,
        });
      }),
    [openChat],
  );

  const systemAlerts = hasDesktopNotifications(mode) || inputNeededAlertsEnabled;
  useEffect(() => {
    const clear = () => {
      for (const { close } of pending.current.values()) close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    if (!systemAlerts) return;
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [systemAlerts]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    // The desktop shell allows sound without a click, and a project window may
    // take over alerts before anyone has clicked in it.
    if (window.desktopBridge && typeof AudioContext !== "undefined") unlockNotificationAudio();
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  if (mode === "off" && !inAppNotificationsEnabled && !inputNeededAlertsEnabled) return null;

  return environmentIds.map((environmentId) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
    />
  ));
}

interface NotificationState {
  readonly raw: OrchestrationV2ThreadShell;
  readonly attention: string | null;
  readonly completion: number | null;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: OnNotification;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  // The shell reducer keeps the thread list and unchanged thread objects
  // stable, so this only rescans when a thread actually changed.
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const inAppNotificationsEnabled = useClientSettings(
    (settings) => settings.inAppNotificationsEnabled,
  );
  const inputNeededAlertsEnabled = useClientSettings(
    (settings) => settings.inputNeededAlertsEnabled === true,
  );
  const openChat = useOpenChat();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  // A project page shows the thread named in `?thread=` in its right panel.
  const paneThreadId = useProjectPaneThreadParam();
  const previous = useRef(new Map<ThreadId, NotificationState>());

  useEffect(() => {
    if (threads === null) {
      previous.current.clear();
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    for (const rawThread of threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const prior = previous.current.get(rawThread.id);
      // The same object cannot produce a new notification.
      if (prior?.raw === rawThread) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" || status === "approval" || status === "failed" || status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      // Commands left running (a dev server) read as ready; subagents and monitors wait.
      const completion =
        status === "ready" &&
        thread.latestRun?.status === "completed" &&
        Number.isFinite(completedAt)
          ? completedAt
          : (prior?.completion ?? null);
      next.set(thread.id, { raw: rawThread, attention, completion });
      if (!prior || thread.archivedAt !== null) continue;
      const kind =
        attention && attention !== prior.attention
          ? "input"
          : completion !== null && (prior.completion === null || completion > prior.completion)
            ? "completion"
            : null;
      if (!kind) continue;
      // Another window announces this event. The state above is still
      // recorded, so taking over later does not replay it.
      if (!isNotificationOwner()) continue;
      const title =
        kind === "completion"
          ? "Thread completed"
          : status === "approval"
            ? "Approval needed"
            : status === "limited"
              ? "Usage limit reached"
              : status === "failed"
                ? "Thread failed"
                : "Input needed";
      // A thread stopped until the user answers or approves.
      const needsUser =
        kind === "input" &&
        inputNeededAlertsEnabled &&
        (status === "input" || status === "approval");
      if (hasNotificationSound(mode)) {
        void playNotificationSound(kind, () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      const inApp = document.visibilityState === "visible" && document.hasFocus();
      if (
        inAppNotificationsEnabled &&
        inApp &&
        (activeEnvironmentId !== environmentId || activeThreadId !== thread.id) &&
        paneThreadId !== thread.id
      ) {
        const toastId = toastManager.add({
          type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
          title,
          description: thread.title,
          data: {
            hideCopyButton: true,
            leadingIcon:
              kind === "completion" ? (
                <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
              ) : status === "approval" ? (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ) : status === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
              ) : (
                <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
              ),
          },
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              void openChat({ environmentId, threadId: thread.id, projectId: thread.projectId });
            },
          },
        });
        continue;
      }
      if ((!hasDesktopNotifications(mode) && !needsUser) || inApp) continue;
      const tag = `${environmentId}:${thread.id}`;
      // Like other macOS apps: the thread's name on top, what happened below.
      const threadName = thread.title.trim();
      const systemTitle =
        threadName.length === 0
          ? title
          : threadName.length > SYSTEM_TITLE_MAX_LENGTH
            ? `${threadName.slice(0, SYSTEM_TITLE_MAX_LENGTH - 1).replace(/[\uD800-\uDBFF]$/, "")}…`
            : threadName;
      const systemBody =
        kind === "completion"
          ? "Finished"
          : status === "approval"
            ? "Waiting for your approval"
            : status === "limited"
              ? "Usage limit reached"
              : status === "failed"
                ? "Stopped with an error"
                : "Waiting for your answer";
      const bridge = window.desktopBridge;
      if (bridge?.showThreadNotification) {
        // The desktop shell posts a native notification and, on click, brings
        // the app forward and opens the thread through onThreadNotificationOpen.
        const shown: ShownNotification = {
          environmentId,
          close: () => void bridge.closeThreadNotification?.(tag).catch(() => undefined),
        };
        onNotification(tag, shown);
        void bridge
          .showThreadNotification({
            tag,
            title: systemTitle,
            body: systemBody,
            target: { environmentId, threadId: thread.id },
          })
          .then(
            (posted) => {
              if (!posted) onNotification(tag, shown, false);
            },
            () => onNotification(tag, shown, false),
          );
        continue;
      }
      if (typeof Notification === "undefined" || Notification.permission !== "granted") continue;
      try {
        const notification = new Notification(systemTitle, {
          body: systemBody,
          tag,
          silent: true,
        });
        onNotification(tag, { environmentId, close: () => notification.close() });
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void openChat({ environmentId, threadId: thread.id, projectId: thread.projectId });
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
    previous.current = next;
    // From here on this window knows what is new, so the desktop shell may
    // pick it to raise alerts. Until then a window that is ready keeps them.
    isNotificationOwner();
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    inAppNotificationsEnabled,
    inputNeededAlertsEnabled,
    mode,
    onNotification,
    openChat,
    paneThreadId,
    threads,
  ]);

  return null;
}
