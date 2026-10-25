import { AttentionFixture } from "./attention-fixture";
/* Isolated UI fixture: all host/provider operations are explicit in-memory fakes. */
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ConnectionsFixture } from "./connections-fixture";
import { ProjectWorkspace } from "../../src/components/studio/ProjectWorkspace";
import {
  projectReturnSearch,
  useRememberProjectDestination,
} from "../../src/studio/projectReturnNavigation";
import {
  parseProjectWorkspaceSearch,
  projectWorkspaceSearch,
} from "../../src/studio/projectPaneThreads";
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
/* Exercises the same route recording and sidebar destination functions with real workspace pages. */
function ReturnSelectionFixture() {
  const read = () => ({
    projectKey: new URLSearchParams(location.search).get("project") ?? "atlas",
    search: parseProjectWorkspaceSearch({
      ...Object.fromEntries(new URLSearchParams(location.search)),
      restoreThread: new URLSearchParams(location.search).get("restoreThread") === "true",
    }),
  });
  const [route, setRoute] = useState(read);
  const go = (projectKey, search, replace = false) => {
    const url = new URL(location.href);
    for (const key of ["thread", "threadEnvironment", "checkout", "restoreThread"])
      url.searchParams.delete(key);
    url.searchParams.set("project", projectKey);
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, String(value));
    history[replace ? "replaceState" : "pushState"](null, "", url);
    setRoute({ projectKey, search });
  };
  useEffect(() => {
    const pop = () => setRoute(read());
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <nav aria-label="Projects" className="flex flex-col gap-2 border-r p-3 text-sm">
        {["atlas", "beacon"].map((key) => (
          <button
            key={key}
            onClick={() =>
              go(
                key,
                new URLSearchParams(location.search).has("baseline")
                  ? {}
                  : projectReturnSearch(
                      key,
                      key === "atlas" ? "host:project" : "host:project-beacon",
                    ),
              )
            }
          >
            {key}
          </button>
        ))}
        <button onClick={() => go(route.projectKey, {})}>Explicit overview</button>
        <button onClick={() => go("atlas", { thread: "review" })}>Direct worker link</button>
      </nav>
      <div style={{ minWidth: 0, flex: 1, display: "flex" }}>
        <ProjectWorkspace
          projectKey={route.projectKey}
          selectedThreadId={route.search.thread ?? null}
          selectedThreadEnvironmentId={route.search.threadEnvironment ?? null}
          restoringThread={route.search.restoreThread}
          onSelectThread={(thread, options) =>
            go(
              route.projectKey,
              projectWorkspaceSearch(thread, route.search.checkout, options?.environmentId),
              options?.replace,
            )
          }
        />
      </div>
    </div>
  );
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
/* `?switch`: the projects sidebar switches the one ProjectWorkspace between two
   projects, the way the real /projects/$projectKey route does, so a project left
   for another stays mounted under its hidden Activity and is shown again. */
function SwitchFixture() {
  const [projectKey, setProjectKey] = useState("atlas");
  // A switch with no press in the sidebar, as a shortcut or a link elsewhere makes.
  useEffect(() => {
    window.__fixtureSwitchProject = (title: string) =>
      setProjectKey(title === "Beacon" ? "beacon" : "atlas");
  }, []);
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <nav aria-label="Projects" className="flex flex-col gap-2 border-r p-3 text-sm">
        {[
          ["atlas", "Atlas Studio"],
          ["beacon", "Beacon"],
        ].map(([key, title]) => (
          <button
            key={key}
            type="button"
            aria-current={key === projectKey ? "page" : undefined}
            onClick={() => setProjectKey(key)}
          >
            {title}
          </button>
        ))}
      </nav>
      <div style={{ minWidth: 0, flex: 1, display: "flex" }}>
        <ProjectWorkspace projectKey={projectKey} />
      </div>
    </div>
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
  search.has("attention") ? (
    <AttentionFixture />
  ) : search.has("connections") ? (
    <ConnectionsFixture />
  ) : search.has("report") ? (
    <SidebarLayout>
      <ProjectWorkspace projectKey="atlas" />
    </SidebarLayout>
  ) : search.has("recovery-navigation") ? (
    <RecoveryNavigationFixture />
  ) : search.has("legacy-delete") ? (
    <LegacyDeletionFixture />
  ) : search.has("returnSelection") ? (
    <ReturnSelectionFixture />
  ) : search.has("switch") ? (
    <SwitchFixture />
  ) : search.has("routed") ? (
    <RoutedProjectWorkspace />
  ) : (
    <ProjectWorkspace projectKey="atlas" />
  ),
);
