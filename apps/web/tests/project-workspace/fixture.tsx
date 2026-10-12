/* Isolated UI fixture: all host/provider operations are explicit in-memory fakes. */
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectWorkspace } from "../../src/components/studio/ProjectWorkspace";
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
const search = new URLSearchParams(location.search);
createRoot(document.getElementById("root")!).render(
  search.has("legacy-delete") ? (
    <LegacyDeletionFixture />
  ) : search.has("routed") ? (
    <RoutedProjectWorkspace />
  ) : (
    <ProjectWorkspace projectKey="atlas" />
  ),
);
