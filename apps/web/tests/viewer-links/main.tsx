/* Isolated fixture: the production viewer overlay and report reader, with links of each kind. */
import { type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Link,
  Outlet,
  RouterProvider,
  useLocation,
} from "@tanstack/react-router";
import type { ScopedThreadRef } from "@specweave-studio/contracts";
import { scopedThreadKey } from "@specweave-studio/client-runtime/environment";

import { ViewerOverlayHost, ViewerOverlayRouteGuard } from "../../src/components/ViewerOverlayHost";
import { ReportReader } from "../../src/components/chat/ReportReader";
import {
  openFileInFront,
  openPullRequestInFront,
  stepOutOfViewerOverlay,
} from "../../src/lib/openInFront";
import { useRightPanelStore } from "../../src/rightPanelStore";
import { useViewerOverlayStore } from "../../src/viewerOverlayStore";
import { AnchoredToastProvider, ToastProvider } from "../../src/components/ui/toast";
import "./fixture.css";

// ?theme=dark
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const threadRef = {
  environmentId: "fixture-host",
  threadId: "thread-1",
} as unknown as ScopedThreadRef;
const PR_URL = "https://github.com/anton-abyzov/specwithcode/pull/442";
const panelTarget = {
  projectId: "project-1",
  repository: "anton-abyzov/specwithcode",
  number: 442,
  url: PR_URL,
};

/** A pull request link, as the app's resolver handles it after finding the project. */
function PullRequestLink() {
  return (
    <a
      href={PR_URL}
      data-link="pull-request"
      onClick={(event) => {
        event.preventDefault();
        const handled = openPullRequestInFront({
          environmentId: "fixture-host" as never,
          threadRef,
          reference: {
            projectId: "project-1" as never,
            repository: "anton-abyzov/specwithcode",
            number: 442,
          },
          url: PR_URL,
          panel: { ref: threadRef, target: panelTarget },
        });
        if (!handled) useRightPanelStore.getState().openPullRequest(threadRef, panelTarget);
      }}
    >
      #442
    </a>
  );
}

function FileLink() {
  return (
    <a
      href="/repo/apps/web/src/permissionWatcher.ts"
      data-link="file"
      onClick={(event) => {
        event.preventDefault();
        openFileInFront({
          threadRef,
          cwd: "/repo",
          path: "/repo/apps/web/src/permissionWatcher.ts",
          line: 12,
        });
      }}
    >
      permissionWatcher.ts
    </a>
  );
}

/** A web link the reader set to open in the app's own browser, in the side panel. */
function InAppBrowserLink() {
  return (
    <a
      href="https://example.com/status"
      data-link="in-app-browser"
      onClick={(event) => {
        event.preventDefault();
        stepOutOfViewerOverlay();
        useBehind.setPreview("https://example.com/status");
      }}
    >
      status page
    </a>
  );
}

const NO_SURFACES: ReadonlyArray<{ readonly id: string }> = [];
const useBehind = { setPreview: (_url: string) => {} };

function Paragraphs(props: { count: number; start: number }) {
  return Array.from({ length: props.count }, (_, index) => (
    <p key={index}>
      Paragraph {props.start + index}: the load spike came from a stitch job, not Spotlight. Each
      worker ran with every core, so the load average far exceeded the real CPU demand.
    </p>
  ));
}

function Report() {
  return (
    <div className="chat-markdown">
      <h1>Reduce Mac load and Spotlight scanning</h1>
      <Paragraphs count={8} start={1} />
      <h2>PR</h2>
      <p>
        <PullRequestLink /> is waiting on the &quot;PR Gate&quot; job. The watcher is in{" "}
        <FileLink />. Status is on the <InAppBrowserLink />. The thread it came from is{" "}
        <Link to="/thread/$threadId" params={{ threadId: "other" }} data-link="thread">
          Clear live thread activity
        </Link>
        .
      </p>
      <Paragraphs count={10} start={9} />
    </div>
  );
}

/** The app behind the overlay: the page and its side panel. */
function Behind(props: { children: ReactNode }) {
  const [preview, setPreview] = useState<string | null>(null);
  useBehind.setPreview = setPreview;
  const surfaces = useRightPanelStore(
    (state) => state.byThreadKey[scopedThreadKey(threadRef)]?.surfaces ?? NO_SURFACES,
  );
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <div className="flex h-screen bg-background text-foreground">
      <main className="flex flex-1 flex-col gap-3 p-6" data-behind-page={pathname}>
        {props.children}
      </main>
      {surfaces.length > 0 || preview ? (
        <aside className="w-80 border-l p-4" data-behind-panel="true">
          <h2 className="font-semibold">Side panel</h2>
          {surfaces.map((surface) => (
            <p key={surface.id} data-panel-surface={surface.id}>
              {surface.id}
            </p>
          ))}
          {preview ? <p data-panel-preview={preview}>Browser: {preview}</p> : null}
        </aside>
      ) : null}
    </div>
  );
}

function Root() {
  const [open, setOpen] = useState(true);
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <Behind>
          <Outlet />
          <button type="button" data-open-report="true" onClick={() => setOpen(true)}>
            Open report
          </button>
        </Behind>
        {/* Mounted at the root, as a Library viewer is: a route change does not unmount it. */}
        <ReportReader
          open={open}
          onOpenChange={setOpen}
          text="report"
          title="Reduce Mac load and Spotlight scanning"
          words={350}
          save={null}
          layout={null}
          threadRef={null}
        >
          <Report />
        </ReportReader>
        <ViewerOverlayHost />
        <ViewerOverlayRouteGuard />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

const rootRoute = createRootRoute({ component: Root });
const routes = [
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <h1 className="text-xl">Coordinator</h1>,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/thread/$threadId",
    component: () => (
      <h1 className="text-xl" data-thread-page="true">
        Thread: Clear live thread activity
      </h1>
    ),
  }),
];
const router = createRouter({
  routeTree: rootRoute.addChildren(routes),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

// The verifier reads the stores' state; it never changes it.
Object.assign(window, {
  fixtureState: () => ({
    overlay: useViewerOverlayStore.getState().active?.title ?? null,
    linked: useViewerOverlayStore.getState().linked?.kind ?? null,
  }),
});

createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
