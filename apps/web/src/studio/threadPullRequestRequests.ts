/**
 * "Create PR" on a thread card in the project chat. The card does not run any
 * source control itself: it opens the thread in the project's right panel with
 * its details panel showing, and leaves a request that the thread's own source
 * control button picks up. That button then does exactly what clicking it does
 * (commit, push and open the pull request, asking first on a default branch).
 */
import { scopedThreadKey } from "@specweave-studio/client-runtime/environment";
import type { GitStackedAction, ScopedThreadRef } from "@specweave-studio/contracts";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { selectThreadPanelOpen, useRightPanelStore } from "../rightPanelStore";

/** Wait this long for the remote half of the status before trusting a local-only one. */
export const PULL_REQUEST_REQUEST_SETTLE_MS = 2_500;
/** A request nobody could act on by then is dropped with the reason. */
export const PULL_REQUEST_REQUEST_TTL_MS = 15_000;

const PULL_REQUEST_ACTIONS: ReadonlySet<GitStackedAction> = new Set([
  "create_pr",
  "commit_push_pr",
]);

const pending = new Map<string, number>();
/** Details panel flags a request turned on, so they do not outlive it. */
const openedPanels = new Map<string, { inline: boolean; popover: boolean }>();
const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Leaves a request for the thread's source control button to open its pull request. */
export function requestThreadPullRequest(ref: ScopedThreadRef, now: number = Date.now()): number {
  pending.set(scopedThreadKey(ref), now);
  emit();
  return now;
}

/** When the request for this thread was made, or null when there is none. */
export function pendingThreadPullRequestAt(ref: ScopedThreadRef | null): number | null {
  return ref === null ? null : (pending.get(scopedThreadKey(ref)) ?? null);
}

/**
 * Puts back the details panel flags a request turned on. The popover is an
 * overlay the store remembers per thread: left on, it would open by itself the
 * next time the thread shows in a narrow layout. The inline panel the request
 * opened stays, since the person is looking at it, unless nothing ever acted.
 */
function settleDetailsPanel(ref: ScopedThreadRef, acted: boolean): void {
  const key = scopedThreadKey(ref);
  const opened = openedPanels.get(key);
  if (!opened) return;
  openedPanels.delete(key);
  const store = useRightPanelStore.getState();
  if (opened.popover) store.setThreadPanelOpen(ref, "popover", false);
  if (opened.inline && !acted) store.setThreadPanelOpen(ref, "inline", false);
}

/** Removes the request; true when there was one to act on. */
export function takeThreadPullRequest(ref: ScopedThreadRef): boolean {
  const had = pending.delete(scopedThreadKey(ref));
  if (had) {
    settleDetailsPanel(ref, true);
    emit();
  }
  return had;
}

/**
 * The card's own deadline: when the request made at `requestedAt` is still
 * waiting (no source control button for the thread ever came on screen, or it
 * never settled), removes it and returns true so the card can say why nothing
 * ran. A newer request for the same thread is left alone.
 */
export function expireThreadPullRequest(ref: ScopedThreadRef, requestedAt: number): boolean {
  const key = scopedThreadKey(ref);
  if (pending.get(key) !== requestedAt) return false;
  pending.delete(key);
  settleDetailsPanel(ref, false);
  emit();
  return true;
}

/** What the card says when its request ran out with nobody acting on it. */
export const PULL_REQUEST_REQUEST_EXPIRED_REASON =
  "The thread's source control did not answer in time. Open the thread's details and use its source control button.";

/** Opens the thread's details panel, where its source control button lives. */
export function showThreadDetailsPanel(ref: ScopedThreadRef): void {
  const store = useRightPanelStore.getState();
  const visibility = store.threadPanelVisibilityByThreadKey;
  // The thread view picks inline or popover by the room it has, which the
  // project page cannot see: open either, and remember which this turned on.
  const opened = {
    inline: !selectThreadPanelOpen(visibility, ref, "inline"),
    popover: !selectThreadPanelOpen(visibility, ref, "popover"),
  };
  const key = scopedThreadKey(ref);
  const previous = openedPanels.get(key);
  openedPanels.set(key, {
    inline: opened.inline || (previous?.inline ?? false),
    popover: opened.popover || (previous?.popover ?? false),
  });
  if (opened.inline) store.setThreadPanelOpen(ref, "inline", true);
  if (opened.popover) store.setThreadPanelOpen(ref, "popover", true);
}

export interface PullRequestQuickAction {
  readonly kind: string;
  readonly action?: GitStackedAction | undefined;
  readonly hint?: string | undefined;
}

export type PullRequestRequestStep =
  | { readonly kind: "wait" }
  | { readonly kind: "run" }
  | { readonly kind: "give_up"; readonly reason: string }
  /** Left long ago while no button was on screen: dropped without a word. */
  | { readonly kind: "drop" };

/** Why the button's own action will not open a pull request. */
export function pullRequestRequestReason(
  quickAction: PullRequestQuickAction,
  hasOpenPullRequest: boolean,
): string {
  if (hasOpenPullRequest) return "This branch already has an open pull request.";
  if (quickAction.kind === "run_pull") return "The branch is behind its remote. Pull it first.";
  if (quickAction.kind === "open_publish")
    return "This repository has no remote yet. Publish it first.";
  if (quickAction.kind === "run_action" && quickAction.action === "commit")
    return "This checkout has no remote to open a pull request on.";
  return quickAction.hint ?? "There is nothing to put in a pull request yet.";
}

/**
 * What the source control button does about a pending request: run its own
 * action once that action opens a pull request, wait while the status loads or
 * another action runs, and give up with the reason once the wait is over.
 *
 * A status read without the remote half says nothing about upstream commits or
 * an open pull request yet, so a pull request action waits for it a moment.
 * Nothing runs at or after the limit: a button that comes on screen late says
 * why instead of committing and pushing long after the click.
 */
export function pullRequestRequestStep(input: {
  readonly quickAction: PullRequestQuickAction;
  readonly canWrite: boolean;
  readonly remoteKnown: boolean;
  /** The status shows an open pull request for the branch. */
  readonly hasOpenPullRequest?: boolean | undefined;
  /** Another source control action is running. */
  readonly busy?: boolean | undefined;
  readonly waitedMs: number;
}): PullRequestRequestStep {
  if (input.waitedMs >= PULL_REQUEST_REQUEST_TTL_MS * 2) return { kind: "drop" };
  if (!input.canWrite)
    return { kind: "give_up", reason: "This connection cannot change source control." };
  const reason = () =>
    pullRequestRequestReason(input.quickAction, input.hasOpenPullRequest ?? false);
  if (input.waitedMs >= PULL_REQUEST_REQUEST_TTL_MS) return { kind: "give_up", reason: reason() };
  if (input.busy) return { kind: "wait" };
  const opensPullRequest =
    input.quickAction.kind === "run_action" &&
    input.quickAction.action !== undefined &&
    PULL_REQUEST_ACTIONS.has(input.quickAction.action);
  if (opensPullRequest && (input.remoteKnown || input.waitedMs >= PULL_REQUEST_REQUEST_SETTLE_MS))
    return { kind: "run" };
  // An open pull request is the remote's answer already: waiting changes nothing.
  if (input.hasOpenPullRequest) return { kind: "give_up", reason: reason() };
  return { kind: "wait" };
}

/** The remote half of a status has arrived: a local-only read reports none of these. */
export function vcsRemoteStatusKnown(
  status: {
    readonly hasUpstream: boolean;
    readonly aheadOfDefaultCount?: number | undefined;
    readonly pr: unknown;
  } | null,
): boolean {
  return (
    status !== null &&
    (status.hasUpstream || status.aheadOfDefaultCount !== undefined || status.pr !== null)
  );
}

/**
 * Lets a thread's source control button act on a "Create PR" request made for it.
 * `run` is the button's own click; `giveUp` tells the person why nothing ran.
 */
export function useThreadPullRequestRequest(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly quickAction: PullRequestQuickAction;
  readonly canWrite: boolean;
  readonly remoteKnown: boolean;
  readonly hasOpenPullRequest?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly run: () => void;
  readonly giveUp: (reason: string) => void;
}): void {
  const { threadRef, quickAction, canWrite, remoteKnown, hasOpenPullRequest, busy } = input;
  const requestedAt = useSyncExternalStore(
    subscribe,
    () => pendingThreadPullRequestAt(threadRef),
    () => null,
  );
  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  // Re-reads the request once the settle or expiry time passes.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (requestedAt === null || threadRef === null) return;
    const waitedMs = Math.max(0, Date.now() - requestedAt);
    const step = pullRequestRequestStep({
      quickAction,
      canWrite,
      remoteKnown,
      hasOpenPullRequest,
      busy,
      waitedMs,
    });
    if (step.kind === "run") {
      if (takeThreadPullRequest(threadRef)) latest.current.run();
      return;
    }
    if (step.kind === "give_up") {
      if (takeThreadPullRequest(threadRef)) latest.current.giveUp(step.reason);
      return;
    }
    if (step.kind === "drop") {
      expireThreadPullRequest(threadRef, requestedAt);
      return;
    }
    const next =
      (waitedMs < PULL_REQUEST_REQUEST_SETTLE_MS
        ? PULL_REQUEST_REQUEST_SETTLE_MS
        : PULL_REQUEST_REQUEST_TTL_MS) - waitedMs;
    const id = window.setTimeout(() => setTick((tick) => tick + 1), next + 1);
    return () => window.clearTimeout(id);
  });
}
