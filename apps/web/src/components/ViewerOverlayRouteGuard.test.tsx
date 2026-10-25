import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ViewerOverlayEntry } from "~/viewerOverlayStore";

type TestLocation = { pathname: string; search: Record<string, unknown>; hash?: string };
let location: TestLocation = { pathname: "/", search: {} };

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (value: TestLocation) => unknown }) => select(location),
}));

const { FocusedFileViewer, ViewerOverlayRouteGuard, viewerRouteIdentity } =
  await import("./ViewerOverlayHost");
const { useFocusedFileStore } = await import("~/lib/openInFront");
const { useViewerOverlayStore } = await import("~/viewerOverlayStore");
const { chatNavigationTarget } = await import("../studio/projectPaneThreads");

const report: ViewerOverlayEntry = {
  key: "report-old-worker",
  title: "Report of old worker",
  kind: "Report",
  badge: null,
  detail: null,
  threadRef: { environmentId: "env-A", threadId: "old-worker" } as ViewerOverlayEntry["threadRef"],
  origin: null,
  trail: [],
  onBack: null,
};

let renderer: ReactTestRenderer | undefined;

async function mountAt(next: TestLocation) {
  location = next;
  await act(async () => {
    renderer = create(<ViewerOverlayRouteGuard />);
  });
  useViewerOverlayStore.getState().open(report);
  expect(useViewerOverlayStore.getState().active?.key).toBe(report.key);
}

async function navigate(next: TestLocation) {
  location = next;
  await act(async () => renderer!.update(<ViewerOverlayRouteGuard />));
  return useViewerOverlayStore.getState().active;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useViewerOverlayStore.setState({ active: null, linked: null });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("viewerRouteIdentity", () => {
  it("names the path and the project pane's thread, machine and checkout", () => {
    const base = { pathname: "/projects/repo-A", search: { thread: "a", checkout: "env-A:p" } };
    expect(viewerRouteIdentity(base)).toBe(viewerRouteIdentity({ ...base }));
    for (const search of [
      { thread: "b", checkout: "env-A:p" },
      { thread: "a", checkout: "env-B:p" },
      { thread: "a", checkout: "env-A:p", threadEnvironment: "env-B" },
    ])
      expect(viewerRouteIdentity({ ...base, search })).not.toBe(viewerRouteIdentity(base));
    expect(viewerRouteIdentity({ ...base, pathname: "/projects/repo-B" })).not.toBe(
      viewerRouteIdentity(base),
    );
  });

  it("ignores view preferences, the restore flag and malformed search", () => {
    const base = { pathname: "/projects/repo-A", search: { thread: "a" } };
    expect(
      viewerRouteIdentity({ ...base, search: { thread: "a", restoreThread: true, tab: "files" } }),
    ).toBe(viewerRouteIdentity(base));
    expect(viewerRouteIdentity({ pathname: "/x", search: null })).toBe(
      viewerRouteIdentity({ pathname: "/x" }),
    );
    // An object where a string belongs is not an identity, and never throws.
    expect(viewerRouteIdentity({ pathname: "/x", search: { thread: { a: 1 } } })).toBe(
      viewerRouteIdentity({ pathname: "/x", search: {} }),
    );
  });
});

describe("ViewerOverlayRouteGuard", () => {
  it("closes the old report when a notification opens another worker in the same project (1039 F-05)", async () => {
    await mountAt({
      pathname: "/projects/repo-A",
      search: { thread: "old-worker", checkout: "env-A:project-A" },
    });
    // The destination a notification click builds, from the real helper.
    const target = chatNavigationTarget(
      {
        id: "new-worker",
        environmentId: "env-A",
        projectId: "project-A",
        createdBy: "agent",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "new-worker" },
        forkedFrom: null,
      } as never,
      {
        projectKey: "repo-A",
        memberProjects: [
          {
            environmentId: "env-A",
            id: "project-A",
            workspaceSettings: { coordinatorThreadId: "coordinator-A" },
          },
        ],
      } as never,
    );
    expect(target.to).toBe("/projects/$projectKey");
    expect("search" in target && target.search.thread).toBe("new-worker");
    const active = await navigate({
      pathname: "/projects/repo-A",
      search: "search" in target ? { ...target.search } : {},
    });
    expect(active).toBeNull();
  });

  it("closes on a new machine or checkout for the same thread", async () => {
    await mountAt({ pathname: "/projects/repo-A", search: { thread: "w", checkout: "env-A:p" } });
    expect(
      await navigate({
        pathname: "/projects/repo-A",
        search: { thread: "w", threadEnvironment: "env-B", checkout: "env-A:p" },
      }),
    ).toBeNull();
  });

  it("closes on a new path, as before", async () => {
    await mountAt({ pathname: "/projects/repo-A", search: {} });
    expect(await navigate({ pathname: "/projects/repo-B", search: {} })).toBeNull();
  });

  it("stays open when only a view preference, the restore flag or the hash changes", async () => {
    await mountAt({ pathname: "/projects/repo-A", search: { thread: "w", checkout: "env-A:p" } });
    for (const next of [
      { thread: "w", checkout: "env-A:p", restoreThread: true },
      { thread: "w", checkout: "env-A:p", tab: "files" },
    ])
      expect((await navigate({ pathname: "/projects/repo-A", search: next }))?.key).toBe(
        report.key,
      );
    expect(
      (
        await navigate({
          pathname: "/projects/repo-A",
          search: { thread: "w", checkout: "env-A:p" },
          hash: "quote-1",
        })
      )?.key,
    ).toBe(report.key);
  });

  it("closes a file a link opened in front (1049 D-05) and forgets it", async () => {
    location = { pathname: "/projects/repo-A", search: { thread: "w" } };
    const tree = () => (
      <>
        <ViewerOverlayRouteGuard />
        <FocusedFileViewer />
      </>
    );
    await act(async () => {
      renderer = create(tree());
    });
    await act(async () =>
      useFocusedFileStore.setState({
        file: { threadRef: report.threadRef!, cwd: "/repo", path: "docs/notes.md", line: 3 },
        from: null,
      }),
    );
    expect(useViewerOverlayStore.getState().active).toMatchObject({
      kind: "File",
      detail: "line 3",
    });
    location = { pathname: "/projects/repo-A", search: { thread: "other" } };
    await act(async () => renderer!.update(tree()));
    expect(useViewerOverlayStore.getState().active).toBeNull();
    expect(useFocusedFileStore.getState()).toEqual({ file: null, from: null });
  });
});
