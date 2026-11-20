import {
  AuthSettingsWriteScope,
  formatStorageFreeSpace,
  type EnvironmentId,
  type StorageCleanupKeepReason,
  type StorageCleanupPlan,
  type StorageCleanupPlanItem,
  type StorageCleanupRemoveReason,
  type StorageCleanupRunResult,
} from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { useState } from "react";

import { englishPhrase, useTx, type TranslatePhrase } from "../i18n";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

type StorageCleanupReason = StorageCleanupRemoveReason | StorageCleanupKeepReason;

/**
 * One plain sentence per reason the cleanup gives, true for every case the server
 * files under it (finishedWorktrees.ts). A `Record` over the contract's reasons, so
 * a reason added on the server is a type error here until it has words.
 */
const REASON_SENTENCES: Readonly<Record<StorageCleanupReason, string>> = {
  merged: "Its pull request merged.",
  closed: "Its pull request closed and every commit is on the remote.",
  resolved: "Its chats are resolved or archived and everything is pushed.",
  deleted: "Its chat was deleted.",
  inactive: "Its chats are resolved or archived and it has been inactive.",
  unchanged: "Its branch has no commits of its own.",
  "interrupted-downloads": "Leftover files of stopped downloads.",
  running: "Work in it has not finished.",
  open: "A chat that is still open works in it or near it.",
  recent: "It was used less than 6 hours ago.",
  changes: "It has uncommitted changes.",
  untracked: "It has files Git does not track.",
  unpushed: "It has commits that exist only on this machine.",
  stash: "A stash was made on its branch.",
  "ignored-files": "It has ignored files that may hold data.",
  media: "It holds more media than is copied automatically.",
  "in-use": "Something is working in it, or it is locked.",
  "broken-registration": "Its Git registration is broken. Check it by hand.",
  "nested-work": "Another repository or hidden changes sit inside it.",
  "no-rule": "No cleanup rule covers it.",
  unknown: "It could not be fully checked, so it is kept.",
};

/**
 * Server details that only repeat the reason's sentence. They are English from the
 * server, so a person reading another language would see the same thing twice.
 */
const REPEATED_DETAILS: Partial<Record<StorageCleanupReason, ReadonlyArray<string>>> = {
  unchanged: ["No commits of its own."],
  "no-rule": ["No cleanup rule that is switched on covers it."],
  unknown: ["It could not be checked.", "It could not be fully checked."],
};

/**
 * How a Git removal failure starts its detail. It arrives as reason "unknown", and the
 * detail (Git's message, the processes holding files) says more than the sentence.
 */
const GIT_REMOVAL_FAILED = "Git could not remove it";

/** The English sentence for a reason; callers translate it with `tx`. */
export function storageCleanupReasonSentence(reason: StorageCleanupReason): string {
  return REASON_SENTENCES[reason];
}

/**
 * The reason in words, with the item's detail (a branch, a file) in parentheses. A Git
 * removal failure shows its detail alone: "could not be fully checked" would be wrong.
 */
export function describeStorageCleanupReason(
  item: Pick<StorageCleanupPlanItem, "reason" | "detail">,
  tx: TranslatePhrase = englishPhrase,
): string {
  const detail = item.detail?.trim() ?? "";
  if (item.reason === "unknown" && detail.startsWith(GIT_REMOVAL_FAILED)) return detail;
  const english = storageCleanupReasonSentence(item.reason);
  const sentence = tx(english);
  const repeats = detail === english || (REPEATED_DETAILS[item.reason] ?? []).includes(detail);
  return detail === "" || repeats ? sentence : `${sentence} (${detail})`;
}

/**
 * Why a check gave no usable answer, or null when it did. A plan with no items that
 * is not complete means the server could not read what it needed, which is not the
 * same as having nothing to remove. `failed` is the server's reason when it sends one.
 */
export function storageCleanupPlanFailure(
  plan: StorageCleanupPlan,
): { readonly reason: string | null } | null {
  const failed =
    "failed" in plan && typeof plan.failed === "string" && plan.failed.trim() !== ""
      ? plan.failed.trim()
      : null;
  if (failed !== null) return { reason: failed };
  return plan.items.length === 0 && !plan.complete ? { reason: null } : null;
}

/** The last two segments of a folder, enough to tell worktrees apart in a list. */
export function storageCleanupFolderLabel(path: string): string {
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== "");
  return segments.length === 0 ? path : segments.slice(-2).join("/");
}

/** The plan's items split into what would go and what stays, in the plan's order. */
export function groupStorageCleanupPlan(plan: StorageCleanupPlan): {
  readonly remove: ReadonlyArray<StorageCleanupPlanItem>;
  readonly keep: ReadonlyArray<StorageCleanupPlanItem>;
} {
  return {
    remove: plan.items.filter((item) => item.action === "remove"),
    keep: plan.items.filter((item) => item.action === "keep"),
  };
}

/**
 * "At least 1.3 GB would be freed", always a lower bound: dependency folders are left
 * out, and a folder whose size is unknown adds nothing to the total.
 */
export function describeStorageCleanupTotal(
  plan: StorageCleanupPlan,
  tx: TranslatePhrase = englishPhrase,
): string {
  return tx("At least {size} would be freed.", {
    size: formatStorageFreeSpace(plan.removableBytes),
  });
}

/** What one "Clean up now" removed. */
export function describeStorageCleanupRun(
  result: StorageCleanupRunResult,
  tx: TranslatePhrase = englishPhrase,
): string {
  const size = formatStorageFreeSpace(result.removedBytes);
  if (result.removed.length === 0) return tx("Nothing was removed.");
  if (result.removed.length === 1) return tx("Removed 1 folder, at least {size}.", { size });
  return tx("Removed {count} folders, at least {size}.", {
    count: result.removed.length,
    size,
  });
}

export type StorageCleanupPlanState =
  | { readonly status: "idle" }
  | { readonly status: "checking" }
  | { readonly status: "ready"; readonly plan: StorageCleanupPlan }
  | { readonly status: "cleaning"; readonly plan: StorageCleanupPlan }
  | {
      readonly status: "cleaned";
      readonly plan: StorageCleanupPlan;
      readonly result: StorageCleanupRunResult;
    }
  | {
      readonly status: "error";
      readonly message: string;
      /** The plan shown before the failure, kept so the list does not vanish. */
      readonly plan: StorageCleanupPlan | null;
    };

const NO_SCOPE_MESSAGE = "This connection cannot change this machine's storage.";

/**
 * The cleanup plan of one machine. Nothing loads by itself: a check costs a host
 * lookup per finished folder, so it runs only when the person presses Check.
 * The client commands are single flight per machine, like old app versions.
 */
export function useStorageCleanupPlan(environmentId: EnvironmentId) {
  const tx = useTx();
  const getPlan = useAtomCommand(serverEnvironment.getStorageCleanupPlan, {
    reportFailure: false,
  });
  const runCleanup = useAtomCommand(serverEnvironment.runStorageCleanup, { reportFailure: false });
  const [state, setState] = useState<StorageCleanupPlanState>({ status: "idle" });
  const shownPlan = "plan" in state ? state.plan : null;

  const check = async () => {
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setState({ status: "error", message: tx(NO_SCOPE_MESSAGE), plan: shownPlan });
      return;
    }
    setState({ status: "checking" });
    const result = await getPlan({ environmentId, input: {} });
    setState(
      result._tag === "Failure"
        ? { status: "error", message: String(Cause.squash(result.cause)), plan: null }
        : { status: "ready", plan: result.value },
    );
  };

  const cleanUp = async () => {
    if (shownPlan === null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setState({ status: "error", message: tx(NO_SCOPE_MESSAGE), plan: shownPlan });
      return;
    }
    setState({ status: "cleaning", plan: shownPlan });
    const result = await runCleanup({ environmentId, input: {} });
    setState(
      result._tag === "Failure"
        ? { status: "error", message: String(Cause.squash(result.cause)), plan: shownPlan }
        : { status: "cleaned", plan: result.value.plan, result: result.value },
    );
  };

  return { state, check, cleanUp };
}
