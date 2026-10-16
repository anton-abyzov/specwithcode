import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  useViewerOverlay,
  useViewerOverlayStore,
  type ViewerOverlaySlots,
} from "./viewerOverlayStore";

const slot = {} as HTMLElement;
const actionsSlot = {} as HTMLElement;
let renderer: ReactTestRenderer | undefined;
const seen: Record<string, HTMLElement | null> = {};

function Viewer(props: {
  name: string;
  open: boolean;
  onClose: () => void;
  file?: string | null;
  onBack?: () => void;
}) {
  const slots: ViewerOverlaySlots | null = useViewerOverlay({
    open: props.open,
    title: props.file ?? props.name,
    kind: props.file ? "File" : "Report",
    badge: "MD",
    detail: "Oct 16 · 55 words",
    trail: props.file ? [{ kind: "Report", title: props.name }] : undefined,
    onBack: props.file ? props.onBack : null,
    onClose: props.onClose,
  });
  seen[props.name] = slots?.content ?? null;
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useViewerOverlayStore.setState({ active: null, slot, actionsSlot });
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

it("tells the header what is open and where: kind, badge, detail, trail and Back", async () => {
  const onClose = vi.fn();
  const onBack = vi.fn();
  await act(async () => {
    renderer = create(<Viewer name="Release notes" open onClose={onClose} />);
  });
  const opened = useViewerOverlayStore.getState().active!;
  expect(opened).toMatchObject({
    title: "Release notes",
    kind: "Report",
    badge: "MD",
    detail: "Oct 16 · 55 words",
    trail: [],
    onBack: null,
  });

  // Opening a linked file inside the report deepens the trail in place.
  await act(async () =>
    renderer!.update(
      <Viewer name="Release notes" open onClose={onClose} file="cds.css" onBack={onBack} />,
    ),
  );
  const deeper = useViewerOverlayStore.getState().active!;
  expect(deeper.key).toBe(opened.key);
  expect(deeper).toMatchObject({
    title: "cds.css",
    kind: "File",
    trail: [{ kind: "Report", title: "Release notes" }],
  });
  deeper.onBack!();
  expect(onBack).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
});
