import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadPanelOpen, useRightPanelStore } from "../rightPanelStore";

import {
  PULL_REQUEST_REQUEST_SETTLE_MS,
  PULL_REQUEST_REQUEST_TTL_MS,
  expireThreadPullRequest,
  pendingThreadPullRequestAt,
  pullRequestRequestStep,
  requestThreadPullRequest,
  showThreadDetailsPanel,
  takeThreadPullRequest,
  vcsRemoteStatusKnown,
} from "./threadPullRequestRequests";

const createPr = { kind: "run_action", action: "create_pr" as const };
const commitPushPr = { kind: "run_action", action: "commit_push_pr" as const };
const step = (input: Partial<Parameters<typeof pullRequestRequestStep>[0]>) =>
  pullRequestRequestStep({
    quickAction: createPr,
    canWrite: true,
    remoteKnown: true,
    waitedMs: 0,
    ...input,
  });

describe("pullRequestRequestStep", () => {
  it("runs the button's own action once it opens a pull request", () => {
    expect(step({})).toEqual({ kind: "run" });
    expect(step({ quickAction: commitPushPr })).toEqual({ kind: "run" });
  });
  it("waits for the remote half of the status a moment before trusting a local read", () => {
    expect(step({ remoteKnown: false })).toEqual({ kind: "wait" });
    expect(step({ remoteKnown: false, waitedMs: PULL_REQUEST_REQUEST_SETTLE_MS })).toEqual({
      kind: "run",
    });
  });
  it("waits while the status loads or another action runs, then gives the reason", () => {
    const hint = { kind: "show_hint", hint: "Git action in progress." };
    expect(step({ quickAction: hint })).toEqual({ kind: "wait" });
    expect(step({ quickAction: hint, waitedMs: PULL_REQUEST_REQUEST_TTL_MS })).toEqual({
      kind: "give_up",
      reason: "Git action in progress.",
    });
    expect(
      step({ quickAction: { kind: "run_action", action: "commit_push" }, waitedMs: 1e9 }).kind,
    ).toBe("drop");
  });
  it("never runs a push to the default branch or anything without the right", () => {
    expect(
      step({
        quickAction: { kind: "run_action", action: "commit_push" },
        waitedMs: PULL_REQUEST_REQUEST_TTL_MS,
      }),
    ).toEqual({ kind: "give_up", reason: "There is nothing to put in a pull request yet." });
    expect(step({ canWrite: false })).toEqual({
      kind: "give_up",
      reason: "This connection cannot change source control.",
    });
  });
});

describe("pullRequestRequestStep limits", () => {
  it("runs nothing at or after the limit, even when the action would open a pull request", () => {
    expect(step({ waitedMs: PULL_REQUEST_REQUEST_TTL_MS })).toEqual({
      kind: "give_up",
      reason: "There is nothing to put in a pull request yet.",
    });
    expect(step({ waitedMs: PULL_REQUEST_REQUEST_TTL_MS + 5_000 }).kind).toBe("give_up");
  });
  it("gives up at once, with the right reason, when the branch already has an open pull request", () => {
    expect(
      step({
        quickAction: { kind: "run_action", action: "commit_push" },
        hasOpenPullRequest: true,
      }),
    ).toEqual({ kind: "give_up", reason: "This branch already has an open pull request." });
  });
  it("waits while another source control action runs", () => {
    expect(step({ busy: true, hasOpenPullRequest: true })).toEqual({ kind: "wait" });
  });
  it("names why a non pull request action will not open one", () => {
    const at = PULL_REQUEST_REQUEST_TTL_MS;
    expect(step({ quickAction: { kind: "run_pull" }, waitedMs: at })).toEqual({
      kind: "give_up",
      reason: "The branch is behind its remote. Pull it first.",
    });
    expect(step({ quickAction: { kind: "open_publish" }, waitedMs: at })).toEqual({
      kind: "give_up",
      reason: "This repository has no remote yet. Publish it first.",
    });
    expect(step({ quickAction: { kind: "run_action", action: "commit" }, waitedMs: at })).toEqual({
      kind: "give_up",
      reason: "This checkout has no remote to open a pull request on.",
    });
  });
});

describe("the card's deadline and the details panel", () => {
  const ref = { environmentId: "host", threadId: "panel-worker" } as never;
  beforeEach(() => {
    takeThreadPullRequest(ref);
    useRightPanelStore.getState().setThreadPanelOpen(ref, "inline", false);
    useRightPanelStore.getState().setThreadPanelOpen(ref, "popover", false);
  });
  const open = (presentation: "inline" | "popover") =>
    selectThreadPanelOpen(
      useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
      ref,
      presentation,
    );

  it("expires only the request it made, not a newer one", () => {
    const first = requestThreadPullRequest(ref, 100);
    requestThreadPullRequest(ref, 200);
    expect(expireThreadPullRequest(ref, first)).toBe(false);
    expect(pendingThreadPullRequestAt(ref)).toBe(200);
    expect(expireThreadPullRequest(ref, 200)).toBe(true);
    expect(pendingThreadPullRequestAt(ref)).toBeNull();
  });
  it("does not leave the popover remembered once the request is taken", () => {
    requestThreadPullRequest(ref, 100);
    showThreadDetailsPanel(ref);
    expect(open("inline")).toBe(true);
    expect(open("popover")).toBe(true);
    expect(takeThreadPullRequest(ref)).toBe(true);
    expect(open("popover")).toBe(false);
    // The panel the person is looking at stays.
    expect(open("inline")).toBe(true);
  });
  it("closes both panels it opened when nobody acted", () => {
    requestThreadPullRequest(ref, 100);
    showThreadDetailsPanel(ref);
    expect(expireThreadPullRequest(ref, 100)).toBe(true);
    expect(open("inline")).toBe(false);
    expect(open("popover")).toBe(false);
  });
  it("leaves a panel that was already open alone", () => {
    useRightPanelStore.getState().setThreadPanelOpen(ref, "popover", true);
    requestThreadPullRequest(ref, 100);
    showThreadDetailsPanel(ref);
    expect(expireThreadPullRequest(ref, 100)).toBe(true);
    expect(open("popover")).toBe(true);
  });
});

describe("the request store", () => {
  it("holds one request per thread until it is taken", () => {
    const ref = { environmentId: "host", threadId: "worker" } as never;
    expect(pendingThreadPullRequestAt(ref)).toBeNull();
    requestThreadPullRequest(ref, 100);
    expect(pendingThreadPullRequestAt(ref)).toBe(100);
    expect(
      pendingThreadPullRequestAt({ environmentId: "laptop", threadId: "worker" } as never),
    ).toBeNull();
    expect(takeThreadPullRequest(ref)).toBe(true);
    expect(takeThreadPullRequest(ref)).toBe(false);
    expect(pendingThreadPullRequestAt(ref)).toBeNull();
  });
});

describe("vcsRemoteStatusKnown", () => {
  it("is known once the remote half reported anything", () => {
    expect(vcsRemoteStatusKnown(null)).toBe(false);
    expect(vcsRemoteStatusKnown({ hasUpstream: false, pr: null })).toBe(false);
    expect(vcsRemoteStatusKnown({ hasUpstream: true, pr: null })).toBe(true);
    expect(vcsRemoteStatusKnown({ hasUpstream: false, aheadOfDefaultCount: 0, pr: null })).toBe(
      true,
    );
  });
});
