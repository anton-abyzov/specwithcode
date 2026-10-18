import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

// The test renderer has no DOM to portal into; a portal shows as a marked wrapper.
vi.mock("react-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-dom")>()),
  createPortal: (children: unknown) => <section data-portal="true">{children as never}</section>,
}));

const { ViewerThreadComposerPortal, threadOwnerKey, useViewerOverlayStore } =
  await import("./viewerOverlayStore");

const coordinator = {
  environmentId: "host" as EnvironmentId,
  threadId: "project-coordinator:atlas" as ThreadId,
};
const worker = { environmentId: "host" as EnvironmentId, threadId: "worker" as ThreadId };
const composerSlot = {} as HTMLElement;
let renderer: ReactTestRenderer | undefined;

function entry(threadRef: typeof coordinator | null) {
  return {
    key: "viewer",
    title: "notes.md",
    kind: "Document",
    badge: null,
    detail: null,
    threadRef,
    origin: null,
    trail: [],
    onBack: null,
  };
}

const portaled = () => renderer!.root.findAll((node) => node.props["data-portal"] === "true");

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useViewerOverlayStore.setState({ active: null, threadComposerSlot: null, composerOwners: [] });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

it("lends the page's composer to the overlay only while it shows that thread", async () => {
  await act(async () => {
    renderer = create(
      <ViewerThreadComposerPortal threadRef={coordinator}>
        <textarea aria-label="Message the coordinator" />
      </ViewerThreadComposerPortal>,
    );
  });
  // The page announces that it owns the coordinator's composer.
  expect(useViewerOverlayStore.getState().composerOwners).toEqual([threadOwnerKey(coordinator)]);
  expect(portaled()).toHaveLength(0);

  await act(async () =>
    useViewerOverlayStore.setState({ active: entry(worker), threadComposerSlot: composerSlot }),
  );
  expect(portaled()).toHaveLength(0);

  await act(async () => useViewerOverlayStore.setState({ active: entry(coordinator) }));
  expect(portaled()).toHaveLength(1);
  expect(renderer!.root.findAllByType("textarea")).toHaveLength(1);

  // Folding the thread away removes the slot: the composer goes back to its page.
  await act(async () => useViewerOverlayStore.setState({ threadComposerSlot: null }));
  expect(portaled()).toHaveLength(0);
  expect(renderer!.root.findAllByType("textarea")).toHaveLength(1);

  await act(async () => renderer!.unmount());
  renderer = undefined;
  expect(useViewerOverlayStore.getState().composerOwners).toEqual([]);
});
