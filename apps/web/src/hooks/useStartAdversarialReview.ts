import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@specweave-studio/client-runtime/state/runtime";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useServerConfigs } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { adversarialReviewNotice } from "../studio/adversarialReview";
import { buildThreadRouteParams } from "../threadRoutes";

/**
 * "Adversarial review" from the thread menu and the command palette: asks
 * the thread's server to start a review by a different model family and says
 * which model took it, or why none could.
 */
export function useStartAdversarialReview(): (threadRef: ScopedThreadRef) => Promise<void> {
  const navigate = useNavigate();
  const configs = useServerConfigs();
  const startReview = useOrchestrationCommand(threadEnvironment.startAdversarialReview, {
    reportFailure: false,
  });
  return useCallback(
    async (threadRef: ScopedThreadRef) => {
      const result = await startReview({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Couldn't start adversarial review",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return;
      }
      const providers = configs.get(threadRef.environmentId)?.providers ?? [];
      const notice = adversarialReviewNotice(result.value, providers);
      const reviewThreadId = notice.reviewThreadId;
      toastManager.add(
        stackedThreadToast({
          type: notice.type,
          title: notice.title,
          ...(notice.description === undefined ? {} : { description: notice.description }),
          ...(reviewThreadId === undefined
            ? {}
            : {
                actionProps: {
                  children: "Open",
                  onClick: () =>
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: buildThreadRouteParams(
                        scopeThreadRef(threadRef.environmentId, reviewThreadId),
                      ),
                    }),
                },
              }),
        }),
      );
    },
    [configs, navigate, startReview],
  );
}
