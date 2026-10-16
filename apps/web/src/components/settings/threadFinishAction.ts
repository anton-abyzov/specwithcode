import type { ThreadFinishAction } from "@specweave-studio/contracts";

export const THREAD_FINISH_ACTION_LABELS: Record<ThreadFinishAction, string> = {
  leave: "Leave branch",
  pull_request: "Open PR",
  auto_merge: "Open PR and auto-merge",
};
