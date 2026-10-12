// @vitest-environment jsdom
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadPanelOpen, useRightPanelStore } from "../rightPanelStore";
import {
  PULL_REQUEST_REQUEST_TTL_MS,
  pendingThreadPullRequestAt,
  requestThreadPullRequest,
  showThreadDetailsPanel,
  takeThreadPullRequest,
  useThreadPullRequestRequest,
  type PullRequestQuickAction,
} from "./threadPullRequestRequests";

const ref = { environmentId: "host", threadId: "worker" } as unknown as ScopedThreadRef;
let renderer: ReactTestRenderer | null = null;
const run = vi.fn();
const giveUp = vi.fn();

function Probe(props: { quickAction: PullRequestQuickAction; remoteKnown?: boolean | undefined }) {
  useThreadPullRequestRequest({
    threadRef: ref,
    quickAction: props.quickAction,
    canWrite: true,
    remoteKnown: props.remoteKnown ?? true,
    run,
    giveUp,
  });
  return null;
}
async function render(quickAction: PullRequestQuickAction, remoteKnown?: boolean) {
  await act(() => {
    if (renderer) renderer.update(<Probe quickAction={quickAction} remoteKnown={remoteKnown} />);
    else renderer = create(<Probe quickAction={quickAction} remoteKnown={remoteKnown} />);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  run.mockReset();
  giveUp.mockReset();
  takeThreadPullRequest(ref);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
});

describe("useThreadPullRequestRequest", () => {
  it("does nothing without a request", async () => {
    await render({ kind: "run_action", action: "create_pr" });
    expect(run).not.toHaveBeenCalled();
  });
  it("runs the button's action once for a request made before it mounted", async () => {
    requestThreadPullRequest(ref);
    await render({ kind: "run_action", action: "commit_push_pr" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(pendingThreadPullRequestAt(ref)).toBeNull();
    await render({ kind: "run_action", action: "commit_push_pr" });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("picks up a request made while it is on screen, once the status says so", async () => {
    await render({ kind: "show_hint", hint: "Git status is unavailable." });
    await act(() => requestThreadPullRequest(ref));
    expect(run).not.toHaveBeenCalled();
    await render({ kind: "run_action", action: "create_pr" });
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("tells why when the status never offers a pull request", async () => {
    await act(() => requestThreadPullRequest(ref));
    await render({ kind: "show_hint", hint: "Branch is up to date. No action needed." });
    await act(async () => {
      vi.advanceTimersByTime(PULL_REQUEST_REQUEST_TTL_MS + 10);
    });
    expect(run).not.toHaveBeenCalled();
    expect(giveUp).toHaveBeenCalledWith("Branch is up to date. No action needed.");
    expect(pendingThreadPullRequestAt(ref)).toBeNull();
  });
});

describe("showThreadDetailsPanel", () => {
  it("opens the thread's details whichever way the card is laid out", () => {
    showThreadDetailsPanel(ref);
    const visibility = useRightPanelStore.getState().threadPanelVisibilityByThreadKey;
    expect(selectThreadPanelOpen(visibility, ref, "inline")).toBe(true);
    expect(selectThreadPanelOpen(visibility, ref, "popover")).toBe(true);
  });
});
