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
        renderThread={(threadRef, { transcriptOnly }) => (
          <div
            className="flex min-h-0 flex-1 flex-col gap-3 p-4 text-sm"
            data-overlay-thread={threadRef.threadId}
            data-overlay-thread-live={transcriptOnly ? undefined : "true"}
          >
            Thread {threadRef.threadId}
            {/* Like the real thread's code blocks and editors, this keeps Escape to itself. */}
            <pre
              tabIndex={0}
              data-overlay-thread-code="true"
              className="rounded bg-muted p-2 font-mono text-xs"
              onKeyDown={(event) => {
                if (event.key === "Escape") event.stopPropagation();
              }}
            >
              /Users/me/Downloads/specwithcode-browser-1.0.0.zip
            </pre>
            {transcriptOnly ? null : (
              // Stands in for ChatView's composer: its pending approval and the input.
              <form
                className="mt-auto flex flex-col gap-2"
                data-overlay-thread-composer="true"
                onSubmit={(event) => {
                  event.preventDefault();
                  const input = event.currentTarget.elements.namedItem("steer");
                  if (input instanceof HTMLTextAreaElement) {
                    window.__overlaySteered = input.value;
                    input.value = "";
                  }
                }}
              >
                <div
                  className="rounded-lg border p-3"
                  role="group"
                  aria-label="Approval"
                  data-overlay-thread-approval="true"
                >
                  <p className="font-medium">Run pnpm test in apps/web?</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" className="rounded border px-2 py-1">
                      Approve
                    </button>
                    <button type="button" className="rounded border px-2 py-1">
                      Decline
                    </button>
                  </div>
                </div>
                <textarea
                  name="steer"
                  aria-label="Steer this thread"
                  placeholder="Steer this thread..."
                  className="min-h-16 rounded-lg border bg-background p-2"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                />
              </form>
            )}
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
