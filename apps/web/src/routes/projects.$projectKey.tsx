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
  const { thread, checkout, threadEnvironment } = Route.useSearch();
  const navigate = Route.useNavigate();
  const selectThread = useCallback<SelectProjectThread>(
    (next, options) => {
      if (
        (next ?? undefined) === thread &&
        (options?.environmentId ?? undefined) === threadEnvironment &&
        options?.hash === undefined
      )
        return;
      // Name the project outright: a late caller must not build a link from another page.
      void navigate({
        to: "/projects/$projectKey",
        params: { projectKey },
        search: projectWorkspaceSearch(next, checkout, options?.environmentId),
        ...(options?.replace ? { replace: true } : {}),
        // A quoted passage to land on in the opened thread.
        ...(options?.hash === undefined
          ? {}
          : { hash: options.hash, state: { ...options.state }, resetScroll: false }),
      });
    },
    [navigate, projectKey, thread, checkout, threadEnvironment],
  );
  // A link made before the repository was known names the machine and path.
  const moveProjectKey = useCallback(
    (next: string) =>
      void navigate({
        to: "/projects/$projectKey",
        params: { projectKey: next },
        search: projectWorkspaceSearch(thread ?? null, checkout, threadEnvironment),
        replace: true,
      }),
    [navigate, thread, checkout, threadEnvironment],
  );
  const selectCheckout = useCallback(
    (key: string) => {
      void navigate({
        to: "/projects/$projectKey",
        params: { projectKey },
        search: projectWorkspaceSearch(null, key),
      });
    },
    [navigate, projectKey],
  );
  return (
    <ProjectWorkspace
      projectKey={projectKey}
      checkoutKey={checkout ?? null}
      onSelectCheckout={selectCheckout}
      selectedThreadId={thread ?? null}
      selectedThreadEnvironmentId={threadEnvironment ?? null}
      onSelectThread={selectThread}
      onProjectKeyMoved={moveProjectKey}
    />
  );
}
