/**
 * The receiver's fixed words: why arriving work got a worktree, what a
 * takeover reason records as, and how notices are joined.
 */
import type { ThreadExecutionReason } from "@specweave-studio/contracts";

import type { InPlaceRefusal } from "./bundleGit.ts";
import type { TakeoverReason } from "./handoffWire.ts";

export const noticeOf = (parts: ReadonlyArray<string | null>) => {
  const notice = parts.filter((part): part is string => part !== null).join(" ");
  return notice.length === 0 ? null : notice.slice(0, 500);
};

/** Why a project with Use worktrees off still got a worktree for arriving work. */
export const IN_PLACE_REFUSAL: Readonly<Record<InPlaceRefusal | "nested", string>> = {
  dirty: "has uncommitted changes",
  moved: "is at a different commit than the work started from",
  blocked: "has files in the way",
  midway: "is in the middle of a merge or rebase",
  nested: "is not the repository this work belongs to",
};

export const EXECUTION_REASON: Readonly<Record<TakeoverReason, ThreadExecutionReason>> = {
  handoff: "handoff",
  "machine-handoff": "machine-handoff",
  sleep: "sleep",
  "continue-here": "continue-here",
  "auto-takeover": "auto-takeover",
};
