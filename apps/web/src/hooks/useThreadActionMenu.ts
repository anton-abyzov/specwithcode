import { isPersonalAssistantProject } from "@specweave-studio/shared/personalAssistant";
import { THREAD_LIFECYCLE_LABELS } from "@specweave-studio/shared/threadLifecycleLabels";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import { requestCustomSnooze } from "../components/CustomSnoozeDialog";
import { requestThreadMove } from "../components/ThreadMoveDialog";
import {
  readHandoffModeSnapshot,
  setThreadHandoffMode,
  threadHandoffMenuState,
} from "../studio/handoffMode";
import { requestHandOffThread } from "../components/handoff/HandOffThreadDialog";
import { threadMoveBlockedReason } from "../components/threadMove.logic";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { canSnooze, effectiveSnoozed } from "@specweave-studio/client-runtime/state/thread-settled";
import {
  AuthOrchestrationOperateScope,
  type ContextMenuItem,
  type ScopedThreadRef,
  type ThreadId,
} from "@specweave-studio/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { resolveSnoozePresets } from "../components/Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "../components/threadActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { readEnvironmentScope } from "../state/session";
import {
  readEnvironmentSupportsAutoSettleOptOut,
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsProjectMove,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsTitleRegeneration,
  readThreadShell,
  useProjects,
} from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { readLocalApi } from "../localApi";
import { canOpenProjectWindowFor, openProjectWindow } from "../lib/projectWindow";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { threadRuntimeCanArchive } from "@specweave-studio/client-runtime/state/models";
import { useCopyToClipboard } from "./useCopyToClipboard";
import { useNewThreadHandler } from "./useHandleNewThread";
import { useClientSettings } from "./useSettings";
import { isCoordinatorNamedThread } from "../studio/threadTitles";
import { useThreadActions } from "./useThreadActions";

/**
 * A header control folded into the menu when its row is too narrow to show it:
 * listed first, above the thread's own actions.
 */
export interface ThreadMenuOverflowItem {
  readonly label: string;
  readonly icon?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

type OverflowMenuId = `overflow:${number}`;

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/**
 * The per-thread action menu (pin, settle, snooze, rename, copy, delete…) as
 * a self-contained hook, for surfaces other than the sidebar row — today the
 * chat header. Renders through the native context-menu bridge and dispatches
 * through the same mutations the sidebar uses.
 *
 * Unlike the sidebar, settle and snooze here never navigate away: the caller
 * is acting on the thread they are reading, and ChatView's parked-thread
 * banner already offers the way back.
 */
export function useThreadActionMenu(input: {
  readonly threadRef: ScopedThreadRef | null;
  /** Fallback for "Copy path" when the thread has no worktree. */
  readonly projectCwd: string | null;
  readonly onStartRename: () => void;
}) {
  const { threadRef, projectCwd, onStartRename } = input;
  const router = useRouter();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const logicalProjectKeyByPhysicalKey = useMemo(
    () =>
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
      }),
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const {
    settleThread,
    unsettleThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    confirmAndUnpinThread,
    setThreadAutoSettle,
    archiveThread,
    deleteThread,
    markThreadUnread,
  } = useThreadActions();
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const handleNewThread = useNewThreadHandler();
  const confirmThreadDelete = useClientSettings((s) => s.confirmThreadDelete);
  const confirmThreadArchive = useClientSettings((s) => s.confirmThreadArchive);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{ path: string }>({
    onCopy: ({ path }) => {
      toastManager.add({ type: "success", title: "Path copied", description: path });
    },
    onError: (error) => failureToast("Failed to copy path", error),
  });
  const { copyToClipboard: copyBranchToClipboard } = useCopyToClipboard<{ branch: string }>({
    target: "branch name",
    onCopy: ({ branch }) => {
      toastManager.add({ type: "success", title: "Branch copied", description: branch });
    },
    onError: (error) => failureToast("Failed to copy branch", error),
  });
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: ({ threadId }) => {
      toastManager.add({ type: "success", title: "Thread ID copied", description: threadId });
    },
    onError: (error) => failureToast("Failed to copy thread ID", error),
  });

  const openMenu = useCallback(
    (position: { x: number; y: number }, overflow: ReadonlyArray<ThreadMenuOverflowItem> = []) => {
      if (threadRef === null) return;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;
        // Snapshot at open time — the menu is modal, so state read now is
        // what the user is looking at.
        const thread = readThreadShell(threadRef);
        if (!thread) return;
        const handoffSnapshot = readHandoffModeSnapshot(threadRef.environmentId);
        const now = new Date();
        const supports = {
          settlement: readEnvironmentSupportsSettlement(threadRef.environmentId),
          autoSettleOptOut: readEnvironmentSupportsAutoSettleOptOut(threadRef.environmentId),
          snooze: readEnvironmentSupportsSnooze(threadRef.environmentId),
          pinning: readEnvironmentSupportsPinning(threadRef.environmentId),
          titleRegeneration: readEnvironmentSupportsTitleRegeneration(threadRef.environmentId),
          projectMove: readEnvironmentSupportsProjectMove(threadRef.environmentId),
        };
        const isRegeneratingTitle = thread.titleRegeneration != null;
        const snoozePresets = resolveSnoozePresets(now, timestampFormat);
        const menuProject = projects.find(
          (candidate) =>
            candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
        );
        const menuProjectKey = menuProject
          ? (logicalProjectKeyByPhysicalKey.get(derivePhysicalProjectKey(menuProject)) ??
            deriveLogicalProjectKeyFromSettings(menuProject, projectGroupingSettings))
          : null;
        const items = buildThreadActionMenuItems({
          canOperate: readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope),
          branch: thread.branch ?? null,
          projectFilter: null,
          isPinned: thread.pinnedAt != null,
          isSettled: supports.settlement && thread.settledOverride === "settled",
          autoSettleEnabled: thread.autoSettleDisabledAt == null,
          isSnoozed: supports.snooze && effectiveSnoozed(thread, { now: now.toISOString() }),
          canSnoozeNow: canSnooze(thread, { now: now.toISOString() }),
          isRegeneratingTitle,
          titleLocked: isCoordinatorNamedThread(thread),
          isRunning: !threadRuntimeCanArchive(thread.runtime),
          canOpenProjectWindow: canOpenProjectWindowFor(menuProjectKey),
          moveToProjectBlockedReason: threadMoveBlockedReason(thread, menuProject),
          // A personal assistant's threads stay on their machine: no handoff items.
          handoff: isPersonalAssistantProject(menuProject)
            ? undefined
            : threadHandoffMenuState(handoffSnapshot, thread.id, thread.projectId),
          supports,
          snoozePresets,
        });
        const overflowItems: ReadonlyArray<ContextMenuItem<OverflowMenuId>> = overflow.map(
          (item, index) => ({
            id: `overflow:${index}`,
            label: item.label,
            ...(item.icon ? { icon: item.icon } : {}),
            ...(item.checked === undefined ? {} : { checked: item.checked }),
            ...(item.disabled ? { disabled: true } : {}),
          }),
        );
        const [firstItem, ...restItems] = items;
        const menu: ReadonlyArray<ContextMenuItem<ThreadActionMenuId | OverflowMenuId>> =
          overflowItems.length === 0 || firstItem === undefined
            ? items
            : [...overflowItems, { ...firstItem, separatorBefore: true }, ...restItems];
        const clicked = await settlePromise(() => api.contextMenu.show(menu, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;
        if (clicked.value.startsWith("overflow:")) {
          overflow[Number(clicked.value.slice("overflow:".length))]?.onSelect();
          return;
        }
        const action = clicked.value as ThreadActionMenuId;
        if (
          threadActionRequiresOperate(action) &&
          !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
        ) {
          failureToast(
            "Thread action unavailable",
            new Error("This connection cannot change threads."),
          );
          return;
        }
        if (action.startsWith("snooze:")) {
          const preset =
            action === "snooze:custom"
              ? await requestCustomSnooze()
              : snoozePresets.find((candidate) => `snooze:${candidate.id}` === action);
          if (!preset) return;
          const result = await snoozeThread(threadRef, preset.snoozedUntil);
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast("Failed to snooze thread", squashAtomCommandFailure(result));
          }
          return;
        }
        const reportFailure = async (
          title: string,
          run: () => Promise<AtomCommandResult<unknown, unknown>>,
        ) => {
          const result = await run();
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            failureToast(title, squashAtomCommandFailure(result));
          }
        };
        switch (action) {
          case "open-project-window":
          case "project-settings": {
            const project = projects.find(
              (candidate) =>
                candidate.environmentId === thread.environmentId &&
                candidate.id === thread.projectId,
            );
            if (!project) return;
            const projectKey =
              logicalProjectKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
              deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings);
            if (action === "open-project-window") {
              void openProjectWindow({ projectKey, title: project.title });
              return;
            }
            void router.navigate({
              to: "/projects/$projectKey",
              params: { projectKey },
            });
            return;
          }
          case "new-thread-on-branch": {
            // Explicit branch carry-over: reuse the thread's worktree when it
            // has one, otherwise its branch on the local checkout.
            const result = await settlePromise(() =>
              handleNewThread(scopeProjectRef(threadRef.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (result._tag === "Failure") {
              failureToast("Could not create thread", squashAtomCommandFailure(result));
            }
            return;
          }
          case "settle":
            await reportFailure(THREAD_LIFECYCLE_LABELS.failedResolve, () =>
              settleThread(threadRef),
            );
            return;
          case "unsettle":
            await reportFailure(THREAD_LIFECYCLE_LABELS.failedReopen, () =>
              unsettleThread(threadRef),
            );
            return;
          case "unsnooze":
            await reportFailure("Failed to wake thread", () => unsnoozeThread(threadRef));
            return;
          case "pin":
            await reportFailure("Failed to pin thread", () => pinThread(threadRef));
            return;
          case "unpin": {
            await reportFailure("Failed to unpin thread", () => confirmAndUnpinThread(threadRef));
            return;
          }
          case "auto-settle:enabled":
          case "auto-settle:disabled":
            await reportFailure(THREAD_LIFECYCLE_LABELS.failedAutoResolve, () =>
              setThreadAutoSettle(threadRef, action === "auto-settle:enabled"),
            );
            return;
          case "rename":
            if (!isCoordinatorNamedThread(thread)) onStartRename();
            return;
          case "regenerate-title":
            if (isRegeneratingTitle || isCoordinatorNamedThread(thread)) return;
            await reportFailure("Failed to regenerate thread title", () =>
              updateThreadMetadata({
                environmentId: threadRef.environmentId,
                input: { threadId: threadRef.threadId, regenerateTitle: true },
              }),
            );
            return;
          case "mark-unread":
            markThreadUnread(threadRef);
            return;
          case "copy-path": {
            const workspacePath = thread.worktreePath ?? projectCwd;
            if (!workspacePath) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPathToClipboard(workspacePath, { path: workspacePath });
            return;
          }
          case "copy-branch":
            if (thread.branch) {
              copyBranchToClipboard(thread.branch, { branch: thread.branch });
            }
            return;
          case "copy-thread-id":
            copyThreadIdToClipboard(thread.id, { threadId: thread.id });
            return;
          case "handoff-mode":
            return;
          case "handoff-mode:inherit":
          case "handoff-mode:on":
          case "handoff-mode:off": {
            const result = await setThreadHandoffMode(
              threadRef.environmentId,
              threadRef.threadId,
              action.slice("handoff-mode:".length) as "inherit" | "on" | "off",
            );
            if (!result.ok) failureToast("Couldn't change handoff mode", new Error(result.error));
            return;
          }
          case "hand-off":
            requestHandOffThread(threadRef);
            return;
          case "move-to-project":
            await requestThreadMove(threadRef);
            return;
          case "archive": {
            if (confirmThreadArchive) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(`Archive thread "${thread.title}"?`),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            let didArchive = false;
            const result = await archiveThread(threadRef, {
              onArchived: () => {
                didArchive = true;
              },
            });
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              failureToast(
                didArchive ? "Thread archived, but navigation failed" : "Failed to archive thread",
                squashAtomCommandFailure(result),
              );
            }
            return;
          }
          case "delete": {
            if (confirmThreadDelete) {
              const confirmed = await settlePromise(() =>
                api.dialogs.confirm(
                  [
                    `Delete thread "${thread.title}"?`,
                    "This permanently clears conversation history for this thread.",
                  ].join("\n"),
                  { variant: "destructive" },
                ),
              );
              if (confirmed._tag === "Failure" || !confirmed.value) return;
            }
            const deleted = await deleteThread(threadRef);
            if (
              deleted._tag === "Failure" &&
              !isAtomCommandInterrupted(deleted) &&
              // A failure with the thread already gone is worktree cleanup
              // failing after a successful delete — deleteThread has toasted
              // that itself, and "Failed to delete thread" would be a lie.
              readThreadShell(threadRef) !== null
            ) {
              failureToast("Failed to delete thread", squashAtomCommandFailure(deleted));
            }
            return;
          }
          default:
            return;
        }
      })();
    },
    [
      archiveThread,
      confirmThreadArchive,
      confirmThreadDelete,
      confirmAndUnpinThread,
      copyBranchToClipboard,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      deleteThread,
      handleNewThread,
      logicalProjectKeyByPhysicalKey,
      markThreadUnread,
      onStartRename,
      pinThread,
      projectCwd,
      projectGroupingSettings,
      projects,
      router,
      setThreadAutoSettle,
      settleThread,
      snoozeThread,
      threadRef,
      timestampFormat,
      unsettleThread,
      unsnoozeThread,
      updateThreadMetadata,
    ],
  );

  const closeMenu = useCallback(() => {
    void readLocalApi()?.contextMenu.close();
  }, []);

  return { openMenu, closeMenu };
}
