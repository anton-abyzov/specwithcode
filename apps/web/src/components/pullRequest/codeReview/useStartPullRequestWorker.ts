import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ScopedThreadRef,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { newMessageId, newThreadId } from "~/lib/utils";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { usePreparePullRequestThreadAction } from "~/state/sourceControlActions";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { scheduledTaskDefaultModel } from "../../settings/scheduledTasksSettings.logic";
import { toastManager } from "../../ui/toast";

/** A provider a worker can be started on right now: enabled, installed, signed in. */
export function isUsableWorkerProvider(entry: ProviderInstanceEntry): boolean {
  return (
    entry.enabled &&
    entry.installed &&
    entry.isAvailable &&
    entry.snapshot.auth.status !== "unauthenticated" &&
    entry.models.some((model) => !model.isLegacy)
  );
}

/** The provider's own default model, else its first current one. */
export function workerModelFor(entry: ProviderInstanceEntry): ModelSelection | null {
  const models = entry.models.filter((model) => !model.isLegacy);
  const model = models.find((candidate) => candidate.isDefault) ?? models[0];
  return model ? { instanceId: entry.instanceId, model: model.slug } : null;
}

export interface PullRequestWorkerTask {
  /** The thread's title in the sidebar and project list. */
  readonly title: string;
  /** The first message the worker receives. */
  readonly prompt: string;
  readonly url: string;
  /** Check the pull request's branch out into a worktree of its own first. */
  readonly checkout: boolean;
  /** Which provider and model; the project's default when absent. */
  readonly model?: ModelSelection;
  /** What the toast calls the work, such as "Fix" or "Review". */
  readonly verb: string;
}

/**
 * Starts a worker thread on a pull request's project with one press: the thread is created,
 * optionally put on the pull request's branch in its own worktree, sent its task, and linked to
 * the pull request so each side shows the other. The reader stays where they are; the toast
 * offers the way to the thread.
 */
export function useStartPullRequestWorker(input: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string | null;
}) {
  const { environmentId, projectId, workspaceRoot } = input;
  const navigate = useNavigate();
  const projects = useProjects();
  const project =
    projects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    ) ?? null;
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const usableEntries = useMemo(() => entries.filter(isUsableWorkerProvider), [entries]);
  const defaultModel = useMemo(
    () => scheduledTaskDefaultModel(settings, project, entries),
    [entries, project, settings],
  );
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const linking = usePullRequestLinking(environmentId);
  const prepareThread = usePreparePullRequestThreadAction({ environmentId, cwd: workspaceRoot });
  const [pending, setPending] = useState<string | null>(null);

  const start = useCallback(
    async (key: string, task: PullRequestWorkerTask): Promise<ScopedThreadRef | null> => {
      if (pending !== null) return null;
      const model = task.model ?? defaultModel;
      if (model === null) {
        toastManager.add({
          type: "error",
          title: "No provider is ready",
          description: "Sign in to a provider in Settings > Providers, then try again.",
        });
        return null;
      }
      setPending(key);
      const toastId = toastManager.add({
        type: "loading",
        title: task.checkout
          ? "Checking out the pull request..."
          : `Starting the ${task.verb.toLowerCase()}...`,
      });
      try {
        let branch: string | null = null;
        let worktreePath: string | null = null;
        if (task.checkout) {
          const prepared = await prepareThread.run({ reference: task.url, mode: "worktree" });
          if (prepared._tag === "Failure") {
            const message =
              prepareThread.error instanceof Error ? prepareThread.error.message : null;
            toastManager.update(toastId, {
              type: "error",
              title: "Could not check out the pull request",
              ...(message ? { description: message } : {}),
            });
            return null;
          }
          branch = prepared.value.branch;
          worktreePath = prepared.value.worktreePath;
        }
        const projectSettings = resolveProjectSettings(settings, projectId, project).settings;
        const runtimeMode = projectSettings.defaultRuntimeMode ?? "full-access";
        const threadId = newThreadId();
        const result = await startTurn({
          environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: task.prompt,
              attachments: [],
            },
            modelSelection: model,
            titleSeed: task.title,
            runtimeMode,
            interactionMode: "default",
            dispatchMode: "start",
            bootstrap: {
              createThread: {
                projectId,
                title: task.title,
                modelSelection: model,
                runtimeMode,
                interactionMode: "default",
                branch,
                worktreePath,
                createdAt: new Date().toISOString(),
              },
            },
          },
        });
        if (result._tag === "Failure") {
          toastManager.update(toastId, {
            type: "error",
            title: `Could not start the ${task.verb.toLowerCase()}`,
            description: "Nothing was sent. Check the provider in Settings, then try again.",
          });
          return null;
        }
        const threadRef = scopeThreadRef(environmentId, threadId);
        // The link is what makes the thread show on the pull request and the pull request on the
        // thread. A failed link leaves a working thread, so it is said rather than undone.
        let linked = true;
        if (linking.mode !== "unsupported" && linking.canLink(task.url)) {
          linked = await linking.changeLink(threadRef, task.url, true).then(
            () => true,
            () => false,
          );
        }
        toastManager.update(toastId, {
          type: "success",
          title: `${task.verb} started`,
          description: linked
            ? "A worker thread is on it and linked to this pull request."
            : "A worker thread is on it. Linking it to the pull request failed.",
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(threadRef),
              });
            },
          },
        });
        return threadRef;
      } finally {
        setPending(null);
      }
    },
    [
      defaultModel,
      environmentId,
      linking,
      navigate,
      pending,
      prepareThread,
      project,
      projectId,
      settings,
      startTurn,
    ],
  );

  return { start, pending, usableEntries, defaultModel };
}
