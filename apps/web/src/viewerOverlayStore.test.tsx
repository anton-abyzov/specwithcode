import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useViewerOverlay, useViewerOverlayStore } from "./viewerOverlayStore";

const slot = {} as HTMLElement;
let renderer: ReactTestRenderer | undefined;
const seen: Record<string, HTMLElement | null> = {};

function Viewer(props: { name: string; open: boolean; onClose: () => void }) {
  seen[props.name] = useViewerOverlay({
    open: props.open,
    title: props.name,
    onClose: props.onClose,
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useViewerOverlayStore.setState({ active: null, slot });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("shows one viewer at a time: opening another closes the first", async () => {
  const closeReport = vi.fn();
  const closeVideo = vi.fn();
  const tree = (videoOpen: boolean) => (
    <>
      <Viewer name="report" open onClose={closeReport} />
      <Viewer name="video" open={videoOpen} onClose={closeVideo} />
    </>
  );
  await act(async () => {
    renderer = create(tree(false));
  });
  expect(seen.report).toBe(slot);
  expect(useViewerOverlayStore.getState().active?.title).toBe("report");
  await act(async () => renderer!.update(tree(true)));
  expect(closeReport).toHaveBeenCalledOnce();
  expect(useViewerOverlayStore.getState().active?.title).toBe("video");
  expect(closeVideo).not.toHaveBeenCalled();
});

it("closes its viewer when the overlay closes, by Escape, the backdrop or X", async () => {
  const onClose = vi.fn();
  await act(async () => {
    renderer = create(<Viewer name="report" open onClose={onClose} />);
  });
  const { active, close } = useViewerOverlayStore.getState();
  await act(async () => close(active!.key));
  expect(onClose).toHaveBeenCalledOnce();
});
