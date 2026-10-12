import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { type EnvironmentId, type ScopedThreadRef, ThreadId } from "@specweave-studio/contracts";
import { act, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useHideRightPanelOnLeave } from "./useHideRightPanelOnLeave";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

let renderer: ReactTestRenderer | null = null;

function ThreadView({ threadRef }: { threadRef: ScopedThreadRef | null }) {
  useHideRightPanelOnLeave(threadRef);
  return null;
}

async function show(element: React.ReactElement) {
  await act(async () => {
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

const panel = (ref: ScopedThreadRef) =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
    closeRevisionByThreadKey: {},
  });
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("useHideRightPanelOnLeave", () => {
  it("arrives back at a thread with its panel closed and its tabs intact", async () => {
    await show(<ThreadView threadRef={refA} />);
    useRightPanelStore.getState().open(refA, "files");
    useRightPanelStore.getState().open(refA, "diff");
    expect(panel(refA).isOpen).toBe(true);

    await show(<ThreadView threadRef={refB} />);
    await show(<ThreadView threadRef={refA} />);

    expect(panel(refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [
        { id: "files", kind: "files" },
        { id: "diff", kind: "diff" },
      ],
    });
  });

  it("closes the panel when the thread view unmounts, as the project pane does per thread", async () => {
    await show(<ThreadView key="a" threadRef={refA} />);
    useRightPanelStore.getState().toggleVisibility(refA);
    await show(<ThreadView key="b" threadRef={refB} />);

    expect(panel(refA).isOpen).toBe(false);
  });

  it("keeps a panel opened while the thread is on screen", async () => {
    await show(<ThreadView threadRef={refA} />);
    useRightPanelStore.getState().open(refA, "diff");
    await show(<ThreadView threadRef={refA} />);

    expect(panel(refA).isOpen).toBe(true);
  });

  it("does not close the panel when a draft becomes its server thread", async () => {
    // A promoted draft keeps its thread id, so the view sees the same thread.
    await show(<ThreadView threadRef={refA} />);
    useRightPanelStore.getState().open(refA, "diff");
    await show(
      <ThreadView
        threadRef={scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"))}
      />,
    );

    expect(panel(refA).isOpen).toBe(true);
  });

  it("does not close the panel when a new view of the same thread replaces the old one", async () => {
    await show(<ThreadView key="draft" threadRef={refA} />);
    useRightPanelStore.getState().open(refA, "diff");
    await show(<ThreadView key="server" threadRef={refA} />);

    expect(panel(refA).isOpen).toBe(true);
  });

  it("keeps a panel opened during mount under StrictMode", async () => {
    function OpensOnMount() {
      useHideRightPanelOnLeave(refA);
      return null;
    }
    useRightPanelStore.getState().open(refA, "diff");
    await show(
      <StrictMode>
        <OpensOnMount />
      </StrictMode>,
    );

    expect(panel(refA).isOpen).toBe(true);
  });
});
