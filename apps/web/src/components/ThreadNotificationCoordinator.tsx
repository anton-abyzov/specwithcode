import { observeNotificationEpisode } from "../notificationEpisodes";
import { observeProjectThread } from "@specweave-studio/client-runtime/state/projectAttention";
import {
  classifyProjectActions,
  projectActionIsCurrent,
  type ProjectAction,
} from "@specweave-studio/shared/projectAttention";
import { presentThreadShell, threadRunHealth } from "@specweave-studio/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import {
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ProjectId,
} from "@specweave-studio/contracts";
import * as Option from "effect/Option";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

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
import { useActiveNotificationThread } from "../hooks/useActiveNotificationThread";
import { resolveSidebarThreadStatus } from "./Sidebar.logic";
import { notificationsConnected, useNotificationsConnected } from "../notificationConnection";
import { deliverNotificationOnce } from "../notificationHistory";
import { toastManager } from "./ui/toast";

/** A system notification still on screen, until the user comes back. */
// The desktop bridge accepts notification titles up to 256 characters.
const SYSTEM_TITLE_MAX_LENGTH = 256;

interface ShownNotification {
  readonly environmentId: EnvironmentId;
  readonly close: () => void;
  readonly actionKey?: string | null;
}

/** Records a shown notification, or forgets it with `posted` false when the system declined it. */
type OnNotification = (tag: string, shown: ShownNotification, posted?: boolean) => void;

export function ThreadNotificationCoordinator() {
  const environmentIds = useEnvironmentIds();
  const connected = useNotificationsConnected();
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

  const onWithdraw = useCallback((tag: string, actionKey?: string | null) => {
    if (actionKey !== undefined && (pending.current.get(tag)?.actionKey ?? null) !== actionKey)
      return;
    pending.current.get(tag)?.close();
    pending.current.delete(tag);
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
      window.desktopBridge?.onThreadNotificationOpen?.(({ environmentId, threadId, projectId }) => {
        if (environmentId === "notification-test" && threadId === "notification-test") return;
        void openChat({
          environmentId: environmentId as EnvironmentId,
          threadId: threadId as ThreadId,
          ...(projectId ? { projectId: projectId as ProjectId } : {}),
        });
      }),
    [openChat],
  );

  const systemAlerts = connected && (hasDesktopNotifications(mode) || inputNeededAlertsEnabled);
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
      onWithdraw={onWithdraw}
    />
  ));
}

interface NotificationState {
  readonly raw: OrchestrationV2ThreadShell;
  readonly attention: string | null;
  readonly actions: readonly { action: ProjectAction; deliveryKey: string | null }[];
  readonly completion: number | null;
  /** The run that went quiet for longer than its work explains, once per run. */
  readonly stalled: string | null;
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
  onWithdraw,
}: {
  environmentId: EnvironmentId;
  onNotification: OnNotification;
  onWithdraw: (tag: string, actionKey?: string | null) => void;
}) {
  const connected = useNotificationsConnected();
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
  const latest = useRef({ threads, mode, inAppNotificationsEnabled, inputNeededAlertsEnabled });
  useLayoutEffect(() => {
    latest.current = { threads, mode, inAppNotificationsEnabled, inputNeededAlertsEnabled };
  }, [threads, mode, inAppNotificationsEnabled, inputNeededAlertsEnabled]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const openChat = useOpenChat();
  const activeThread = useActiveNotificationThread();
  const activeEnvironmentId = activeThread?.environmentId;
  const activeThreadId = activeThread?.threadId;
  const latestActiveThread = useRef(activeThread);
  useLayoutEffect(() => {
    latestActiveThread.current = activeThread;
  }, [activeThread]);
  const previous = useRef(new Map<ThreadId, NotificationState>());
  const previousConnection = useRef(connected);
  const nativeRefusals = useRef(new Map<string, number>());
  // Stalls come from time passing, not from a thread changing.
  const [nowMinute, setNowMinute] = useState(() => Math.floor(Date.now() / 60_000));
  useEffect(() => {
    const timer = globalThis.setInterval(
      () => setNowMinute(Math.floor(Date.now() / 60_000)),
      60_000,
    );
    return () => globalThis.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (previousConnection.current !== connected) {
      previous.current.clear();
      nativeRefusals.current.clear();
      previousConnection.current = connected;
    }
    const nowMs = nowMinute * 60_000;
    if (threads === null) {
      // Keep the baseline during a disconnect so missed transitions are observed on reconnect.
      return;
    }
    const next = new Map<ThreadId, NotificationState>();
    for (const rawThread of threads) {
      // A provider's own subagents are part of their parent's turn. A worker a
      // coordinator delegated is its own thread: its status and this alert
      // tell the user it finished, not the coordinator.
      if (isProviderNativeSubagentThread(rawThread)) continue;
      const prior = previous.current.get(rawThread.id);
      const thread = presentThreadShell(environmentId, rawThread);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const observation = observeProjectThread(thread, "live");
      const observedActions = classifyProjectActions(observation);
      // Baseline absence must end persisted episodes too, including after every client restarted.
      for (const reason of ["plan", "held"] as const) {
        if (
          (!prior || prior.raw !== rawThread) &&
          !observedActions.some((action) => action.reason === reason)
        ) {
          const scope = JSON.stringify([
            environmentId,
            thread.projectId,
            thread.id,
            observation.generation,
            reason,
          ]);
          void observeNotificationEpisode(scope, false, observation.revision, false);
        }
      }
      const episodeIds = new Map<string, Promise<string | null>>();
      const actions = observedActions.map((action) => {
        if (action.reason !== "plan" && action.reason !== "held")
          return { action, deliveryKey: action.key };
        const existing = prior?.actions.find(
          (candidate) =>
            candidate.action.reason === action.reason &&
            candidate.action.generation === action.generation,
        );
        // Shell revisions are not durable request IDs. Only a witnessed state transition
        // starts an episode; later revisions keep its key, including while delivery is queued.
        const scope = JSON.stringify([
          environmentId,
          thread.projectId,
          thread.id,
          action.generation,
          action.reason,
        ]);
        episodeIds.set(
          scope,
          observeNotificationEpisode(scope, true, action.revision, !!prior && !existing),
        );
        return { action, deliveryKey: existing ? existing.deliveryKey : prior ? scope : null };
      });
      const attention =
        status === "failed" || status === "limited"
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
      const health = threadRunHealth(thread, nowMs);
      const stalled =
        health?.state === "stalled"
          ? (thread.latestRun?.runId ?? thread.id)
          : prior?.stalled === (thread.latestRun?.runId ?? thread.id)
            ? prior.stalled
            : null;
      next.set(thread.id, { raw: rawThread, attention, actions, completion, stalled });
      if (prior?.attention && prior.attention !== attention)
        onWithdraw(`${environmentId}:${thread.id}`, null);
      for (const previousAction of prior?.actions ?? []) {
        if (
          previousAction.deliveryKey !== null &&
          !actions.some((candidate) => candidate.deliveryKey === previousAction.deliveryKey)
        )
          onWithdraw(`${environmentId}:${thread.id}`, previousAction.deliveryKey);
        if (
          (previousAction.action.reason === "plan" || previousAction.action.reason === "held") &&
          !actions.some(
            (candidate) =>
              candidate.action.reason === previousAction.action.reason &&
              candidate.action.generation === previousAction.action.generation,
          )
        ) {
          const scope = JSON.stringify([
            environmentId,
            thread.projectId,
            thread.id,
            previousAction.action.generation,
            previousAction.action.reason,
          ]);
          void observeNotificationEpisode(scope, false, thread.updatedAt, false);
        }
      }
      if (thread.archivedAt !== null || thread.deletedAt != null) continue;
      const candidates: Array<{
        kind: "action" | "operational" | "completion" | "stalled";
        action?: ProjectAction;
        identity: string | number;
        soundChanged: boolean;
      }> = actions
        .filter((candidate) => candidate.deliveryKey !== null)
        .map(({ action, deliveryKey }) => ({
          kind: "action",
          action,
          identity: deliveryKey!,
          soundChanged: !prior?.actions.some((candidate) => candidate.deliveryKey === deliveryKey),
        }));
      // New clients never announce historical operational failures or completions.
      if (prior) {
        if (attention && attention !== prior.attention)
          candidates.push({ kind: "operational", identity: attention, soundChanged: true });
        else if (
          completion !== null &&
          (prior.completion === null || completion > prior.completion)
        )
          candidates.push({ kind: "completion", identity: completion, soundChanged: true });
        else if (stalled !== null && stalled !== prior.stalled && health?.state === "stalled")
          candidates.push({ kind: "stalled", identity: stalled, soundChanged: true });
      }
      if (!isNotificationOwner()) continue;
      for (const { kind, action, identity, soundChanged } of candidates) {
        const dispatch = async () => {
          const deliveryIdentity = episodeIds.has(String(identity))
            ? await episodeIds.get(String(identity))
            : identity;
          if (deliveryIdentity == null) return;
          const eventKey = JSON.stringify([
            environmentId,
            thread.projectId,
            thread.id,
            kind,
            deliveryIdentity,
          ]);
          await deliverNotificationOnce(eventKey, async () => {
            // Web Locks may wait behind a native delivery. Never send using stale preferences or requests.
            if (!mounted.current || !isNotificationOwner()) return false;
            const {
              threads: currentThreads,
              mode,
              inAppNotificationsEnabled,
              inputNeededAlertsEnabled,
            } = latest.current;
            const currentRaw = currentThreads?.find((candidate) => candidate.id === rawThread.id);
            if (!currentRaw || currentRaw.archivedAt !== null || currentRaw.deletedAt != null)
              return false;
            const currentThread = presentThreadShell(environmentId, currentRaw);
            let currentStatus = resolveSidebarThreadStatus(currentThread);
            if (currentStatus === "ready" && currentThread.latestRun?.status === "failed")
              currentStatus = "failed";
            if (
              kind === "operational" &&
              (currentStatus !== status ||
                currentRaw.latestRunId !== rawThread.latestRunId ||
                currentRaw.pendingRuntimeRequest?.id !== rawThread.pendingRuntimeRequest?.id)
            )
              return false;
            if (
              action &&
              !projectActionIsCurrent(action, observeProjectThread(currentThread, "live"))
            )
              return false;
            if (
              kind === "completion" &&
              (currentStatus !== "ready" ||
                currentThread.latestRun?.completedAt !== thread.latestRun?.completedAt)
            )
              return false;
            if (
              kind === "stalled" &&
              (currentRaw.latestRunId !== rawThread.latestRunId ||
                threadRunHealth(currentThread, Date.now())?.state !== "stalled")
            )
              return false;
            const title =
              kind === "stalled"
                ? "No activity in thread"
                : kind === "completion"
                  ? "Thread completed"
                  : action?.reason === "approval"
                    ? "Approval needed"
                    : action?.reason === "signin"
                      ? "Sign-in needed"
                      : action?.reason === "plan"
                        ? "Plan review needed"
                        : action?.reason === "held"
                          ? "Queued messages need a decision"
                          : status === "limited"
                            ? "Usage limit reached"
                            : status === "failed"
                              ? "Thread failed"
                              : "Input needed";
            // A thread stopped until the user answers or approves.
            const needsUser = action !== undefined && inputNeededAlertsEnabled;
            if (hasNotificationSound(mode) && soundChanged) {
              void playNotificationSound(kind === "completion" ? "completion" : "input", () =>
                hasNotificationSound(getClientSettings().notificationMode),
              );
            }
            const inApp = document.visibilityState === "visible" && document.hasFocus();
            if (
              inAppNotificationsEnabled &&
              inApp &&
              (latestActiveThread.current?.environmentId !== environmentId ||
                latestActiveThread.current?.threadId !== thread.id)
            ) {
              const toastId = toastManager.add({
                type:
                  kind === "completion"
                    ? "success"
                    : status === "failed" && kind !== "stalled"
                      ? "error"
                      : "warning",
                title,
                description: thread.title,
                data: {
                  hideCopyButton: true,
                  leadingIcon:
                    kind === "stalled" ? (
                      <CircleAlertIcon aria-hidden className="size-4 text-warning-foreground" />
                    ) : kind === "completion" ? (
                      <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
                    ) : action?.reason === "approval" ? (
                      <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
                    ) : status === "failed" ? (
                      <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
                    ) : (
                      <MessageCircleQuestionIcon
                        aria-hidden
                        className="size-4 text-info-foreground"
                      />
                    ),
                },
                actionProps: {
                  children: "Open thread",
                  onClick: () => {
                    toastManager.close(toastId);
                    void openChat({
                      environmentId,
                      threadId: thread.id,
                      projectId: thread.projectId,
                    });
                  },
                },
              });
              return true;
            }
            if (
              !notificationsConnected() ||
              (!hasDesktopNotifications(mode) && !needsUser) ||
              inApp
            )
              return false;
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
              kind === "stalled" && health !== null
                ? `No activity for ${Math.floor(health.idleMs / 60_000)} min. Stop or continue it.`
                : kind === "completion"
                  ? "Finished"
                  : action?.reason === "approval"
                    ? "Waiting for your approval"
                    : action?.reason === "signin"
                      ? "Sign in to continue"
                      : action?.reason === "plan"
                        ? "Review the proposed plan"
                        : action?.reason === "held"
                          ? "Resume or discard the held queue"
                          : status === "limited"
                            ? "Usage limit reached"
                            : status === "failed"
                              ? "Stopped with an error"
                              : "Waiting for your answer";
            const bridge = window.desktopBridge;
            if (bridge?.showThreadNotification) {
              // An OS denial must not turn every token/shell update into another native request.
              const now = Date.now();
              for (const [key, until] of nativeRefusals.current) {
                if (until <= now) nativeRefusals.current.delete(key);
              }
              if (nativeRefusals.current.has(eventKey)) return false;
              // The desktop shell posts a native notification and, on click, brings
              // the app forward and opens the thread through onThreadNotificationOpen.
              const shown: ShownNotification = {
                environmentId,
                actionKey: action ? String(identity) : null,
                close: () => void bridge.closeThreadNotification?.(tag).catch(() => undefined),
              };
              onNotification(tag, shown);
              return bridge
                .showThreadNotification({
                  tag,
                  title: systemTitle,
                  body: systemBody,
                  target: { environmentId, threadId: thread.id, projectId: thread.projectId },
                })
                .then(
                  (posted) => {
                    if (!posted) {
                      nativeRefusals.current.set(eventKey, Date.now() + 30_000);
                      onNotification(tag, shown, false);
                    }
                    if (!notificationsConnected()) shown.close();
                    return posted;
                  },
                  () => {
                    nativeRefusals.current.set(eventKey, Date.now() + 30_000);
                    onNotification(tag, shown, false);
                    return false;
                  },
                );
            }
            if (typeof Notification === "undefined" || Notification.permission !== "granted")
              return false;
            try {
              const notification = new Notification(systemTitle, {
                body: systemBody,
                tag,
                silent: true,
              });
              onNotification(tag, {
                environmentId,
                actionKey: action ? String(identity) : null,
                close: () => notification.close(),
              });
              notification.addEventListener("click", () => {
                notification.close();
                window.focus();
                void openChat({ environmentId, threadId: thread.id, projectId: thread.projectId });
              });
              return true;
            } catch {
              return false;
            }
          });
        };
        void dispatch();
      }
    }
    for (const id of previous.current.keys()) {
      if (!next.has(id)) onWithdraw(`${environmentId}:${id}`);
    }
    previous.current = next;
    // From here on this window knows what is new, so the desktop shell may
    // pick it to raise alerts. Until then a window that is ready keeps them.
    isNotificationOwner();
  }, [
    connected,
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    inAppNotificationsEnabled,
    inputNeededAlertsEnabled,
    mode,
    nowMinute,
    onNotification,
    onWithdraw,
    openChat,
    threads,
  ]);

  return null;
}
