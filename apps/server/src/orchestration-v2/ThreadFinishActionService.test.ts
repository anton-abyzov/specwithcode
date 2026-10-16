import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2Run } from "@specweave-studio/contracts";

import {
  branchReadyForPullRequest,
  latestStartedRun,
  mergeStep,
  threadFinished,
} from "./ThreadFinishActionService.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const run = (
  ordinal: number,
  status: OrchestrationV2Run["status"],
  completedAt: string | null = null,
): OrchestrationV2Run =>
  ({
    id: `run-${ordinal}`,
    ordinal,
    status,
    completedAt: completedAt === null ? null : at(completedAt),
  }) as unknown as OrchestrationV2Run;

const cleanBranch = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feat/x",
  hasWorkingTreeChanges: false,
  aheadOfDefaultCount: 2,
  pr: null,
} as const;

describe("thread finish action", () => {
  it("treats a thread as finished only when its last turn completed and nothing waits", () => {
    expect(threadFinished([run(1, "completed", "2026-10-15T10:00:00Z")])).toBe(true);
    expect(threadFinished([run(1, "completed", "2026-10-15T10:00:00Z"), run(2, "queued")])).toBe(
      false,
    );
    expect(threadFinished([run(1, "completed", "2026-10-15T10:00:00Z"), run(2, "running")])).toBe(
      false,
    );
    expect(
      threadFinished([
        run(1, "completed", "2026-10-15T10:00:00Z"),
        run(2, "interrupted", "2026-10-15T11:00:00Z"),
      ]),
    ).toBe(false);
    expect(threadFinished([])).toBe(false);
  });

  it("picks the run that ended last, ignoring queued and rolled back runs", () => {
    const runs = [
      run(1, "completed", "2026-10-15T12:00:00Z"),
      run(2, "failed", "2026-10-15T11:00:00Z"),
      run(3, "rolled_back", "2026-10-15T13:00:00Z"),
    ];
    expect(latestStartedRun(runs)?.id).toBe("run-1");
  });

  it("proposes only a clean feature branch with commits or an open PR", () => {
    expect(branchReadyForPullRequest(cleanBranch, "feat/x")).toBe(true);
    expect(branchReadyForPullRequest({ ...cleanBranch, isDefaultRef: true }, "feat/x")).toBe(false);
    expect(
      branchReadyForPullRequest({ ...cleanBranch, hasWorkingTreeChanges: true }, "feat/x"),
    ).toBe(false);
    expect(branchReadyForPullRequest({ ...cleanBranch, refName: "other" }, "feat/x")).toBe(false);
    expect(branchReadyForPullRequest({ ...cleanBranch, aheadOfDefaultCount: 0 }, "feat/x")).toBe(
      false,
    );
    expect(branchReadyForPullRequest({ ...cleanBranch, hasPrimaryRemote: false }, "feat/x")).toBe(
      false,
    );
  });

  it("merges a ready PR, hands a pending one to auto-merge and refuses a broken one", () => {
    const base = { number: 123, state: "open", baseBranch: "develop" } as const;
    expect(mergeStep({ ...base, checksState: "passing", mergeability: "mergeable" })).toEqual({
      type: "merge",
    });
    expect(mergeStep({ ...base, checksState: null, mergeability: "mergeable" })).toEqual({
      type: "merge",
    });
    expect(mergeStep({ ...base, checksState: "pending", mergeability: "mergeable" })).toEqual({
      type: "auto-merge",
    });
    expect(mergeStep({ ...base, checksState: "passing", mergeability: "unknown" })).toEqual({
      type: "auto-merge",
    });
    expect(mergeStep({ ...base, checksState: "failing", mergeability: "mergeable" })).toEqual({
      type: "done",
      notice: "blocked",
      message: "Checks failed on #123; not merging into develop",
    });
    expect(
      mergeStep({ ...base, checksState: "passing", mergeability: "conflicting" }),
    ).toMatchObject({ type: "done", notice: "blocked" });
    expect(mergeStep({ ...base, state: "merged" })).toEqual({
      type: "done",
      notice: "merged",
      message: "Merged #123 into develop",
    });
  });
});
