/* Isolated UI fixture: all host/provider operations are explicit in-memory fakes. */
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionsFixture } from "./connections-fixture";
import { ProjectWorkspace } from "../../src/components/studio/ProjectWorkspace";
import { ViewerOverlayHost } from "../../src/components/ViewerOverlayHost";
import { useProjectDeletionConfirmation } from "../../src/components/studio/useProjectDeletionConfirmation";
function LegacyDeletionFixture() {
  const { confirmDeletion, deletionDialog } = useProjectDeletionConfirmation();
  return (
    <>
      {deletionDialog}
      <button
        onClick={() =>
          void confirmDeletion({ title: "Atlas Studio", workspaceRoot: "/scratch/atlas" }).then(
            (typed) => {
              window.__deletionReceipt = typed;
            },
          )
        }
      >
        Open legacy deletion
      </button>
    </>
  );
}
/* `?routed`: the open thread lives in the URL as `?thread=<id>`, as the real
   /projects/$projectKey route keeps it, so reload and back/forward land on it. */
const readThread = () => new URLSearchParams(location.search).get("thread");
function RoutedProjectWorkspace() {
  const [thread, setThread] = useState(readThread);
  useEffect(() => {
    const onPop = () => setThread(readThread());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const select = useCallback((next, options) => {
    const url = new URL(location.href);
    if (next === null) url.searchParams.delete("thread");
    else url.searchParams.set("thread", next);
    if (options?.replace) history.replaceState(null, "", url);
    else history.pushState(null, "", url);
    setThread(next);
  }, []);
  return <ProjectWorkspace projectKey="atlas" selectedThreadId={thread} onSelectThread={select} />;
}
function RecoveryNavigationFixture() {
  const [inside, setInside] = useState(true);
  return (
    <>
      <button onClick={() => setInside(!inside)}>
        {inside ? "Leave project fixture" : "Return to project fixture"}
      </button>
      {inside && <ProjectWorkspace projectKey="atlas" />}
    </>
  );
}
/* `?report`: the app's projects sidebar beside the workspace, so the viewer
   overlay can be checked never to cover it. The thread beside a viewer is a
   stand-in; the native ChatView is not part of this fixture. */
function SidebarLayout(props: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div data-slot="sidebar" data-side="left" className="hidden md:block">
        <nav
          data-slot="sidebar-container"
          aria-label="Projects"
          className="h-full border-r bg-sidebar p-3 text-sm"
          style={{ width: 240 }}
        >
          <button type="button" onClick={() => (window.__projectClicked = true)}>
            Atlas Studio
          </button>
        </nav>
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>{props.children}</div>
      <ViewerOverlayHost
        renderThread={(threadRef) => (
          <div className="p-4 text-sm" data-overlay-thread={threadRef.threadId}>
            Thread {threadRef.threadId}
          </div>
        )}
      />
    </div>
  );
}
const search = new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(
  search.has("connections") ? (
    <ConnectionsFixture />
  ) : search.has("report") ? (
    <SidebarLayout>
      <ProjectWorkspace projectKey="atlas" />
    </SidebarLayout>
  ) : search.has("recovery-navigation") ? (
    <RecoveryNavigationFixture />
  ) : search.has("legacy-delete") ? (
    <LegacyDeletionFixture />
  ) : search.has("routed") ? (
    <RoutedProjectWorkspace />
  ) : (
    <ProjectWorkspace projectKey="atlas" />
  ),
);
