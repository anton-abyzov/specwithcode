import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback } from "react";
import { ProjectWorkspace } from "../components/studio/ProjectWorkspace";
import { parseProjectWorkspaceSearch, projectWorkspaceSearch } from "../studio/projectPaneThreads";
import type { SelectProjectThread } from "../studio/useProjectPaneSelection";
export const Route = createFileRoute("/projects/$projectKey")({
  // `?thread=<id>` is the thread open in the right panel, so links, reload and
  // back/forward all land on it.
  validateSearch: parseProjectWorkspaceSearch,
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    )
      throw redirect({ to: "/pair", replace: true });
  },
  component: ProjectWorkspaceRoute,
});
function ProjectWorkspaceRoute() {
  const { projectKey } = Route.useParams();
  const { thread } = Route.useSearch();
  const navigate = Route.useNavigate();
  const selectThread = useCallback<SelectProjectThread>(
    (next, options) => {
      if ((next ?? undefined) === thread && options?.hash === undefined) return;
      // Name the project outright: a late caller must not build a link from another page.
      void navigate({
        to: "/projects/$projectKey",
        params: { projectKey },
        search: projectWorkspaceSearch(next),
        ...(options?.replace ? { replace: true } : {}),
        // A quoted passage to land on in the opened thread.
        ...(options?.hash === undefined
          ? {}
          : { hash: options.hash, state: { ...options.state }, resetScroll: false }),
      });
    },
    [navigate, projectKey, thread],
  );
  return (
    <ProjectWorkspace
      projectKey={projectKey}
      selectedThreadId={thread ?? null}
      onSelectThread={selectThread}
    />
  );
}
