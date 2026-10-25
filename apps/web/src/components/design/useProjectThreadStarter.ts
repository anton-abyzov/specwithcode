import { scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@specweave-studio/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { useCallback } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import {
  durableComposerDrafts,
  durableTargetForStoreKey,
  snapshotOfThreadDraft,
} from "~/lib/durableComposerDraftBindings";
import { newMessageId } from "~/lib/utils";
import { threadEnvironment } from "~/state/threads";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";

import {
  seedThreadComposer,
  startProjectThread,
  type ProjectThreadRequest,
  type ProjectThreadResult,
} from "./projectThread";
import type { DesignMessage } from "./editor/backend";

function failureOf<A, E>(result: AtomCommandResult<A, E>, fallback: string): string | null {
  if (result._tag === "Success") return null;
  const cause = squashAtomCommandFailure(result);
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  if (typeof cause === "object" && cause !== null && "detail" in cause) return String(cause.detail);
  return fallback;
}

/**
 * Puts the message in the thread's composer and saves that draft to the host
 * at once: the composers' own sync starts only when a thread opens in this
 * window, and the host copy is what another window or device shows.
 */
function holdInComposer(thread: ScopedThreadRef, message: DesignMessage) {
  seedThreadComposer(useComposerDraftStore.getState(), thread, message);
  const storeKey = scopedThreadKey(thread);
  const target = durableTargetForStoreKey(storeKey, () => undefined);
  if (target === null) return;
  const draft = useComposerDraftStore.getState().draftsByThreadKey[storeKey];
  durableComposerDrafts.schedule(target, snapshotOfThreadDraft(draft));
}

/**
 * Starts a new thread in a project with a first message (see
 * startProjectThread): launched on a ready model, or created with no turn and
 * the message waiting in its composer.
 */
export function useProjectThreadStarter(): (
  request: ProjectThreadRequest,
) => Promise<ProjectThreadResult> {
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
  const createThread = useOrchestrationCommand(threadEnvironment.create, {
    reportFailure: false,
  });
  return useCallback(
    (request) =>
      startProjectThread(
        {
          launch: async (thread) =>
            failureOf(
              await startTurn({
                environmentId: thread.environmentId,
                input: {
                  threadId: thread.threadId,
                  message: {
                    messageId: newMessageId(),
                    role: "user",
                    text: thread.message.text,
                    attachments: thread.message.images.map((image) => ({
                      type: "image" as const,
                      ...image,
                    })),
                  },
                  modelSelection: thread.modelSelection,
                  titleSeed: thread.title,
                  runtimeMode: thread.runtimeMode,
                  interactionMode: "default",
                  dispatchMode: "start",
                  bootstrap: {
                    createThread: {
                      projectId: thread.projectId,
                      title: thread.title,
                      modelSelection: thread.modelSelection,
                      runtimeMode: thread.runtimeMode,
                      interactionMode: "default",
                      branch: null,
                      worktreePath: null,
                      createdAt: new Date().toISOString(),
                    },
                  },
                },
              }),
              "The provider did not respond.",
            ),
          create: async (thread) =>
            failureOf(
              await createThread({
                environmentId: thread.environmentId,
                input: {
                  threadId: thread.threadId,
                  projectId: thread.projectId,
                  title: thread.title,
                  modelSelection: thread.modelSelection,
                  runtimeMode: thread.runtimeMode,
                  interactionMode: "default",
                  branch: null,
                  worktreePath: null,
                  createdAt: new Date().toISOString(),
                },
              }),
              "The thread was not created.",
            ),
          hold: holdInComposer,
        },
        request,
      ),
    [createThread, startTurn],
  );
}
