import { createFileRoute, redirect } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { ProjectWorkspace } from "../components/studio/ProjectWorkspace";
import {
  parseProjectWorkspaceSearch,
  projectKeyMoveSearch,
  projectWorkspaceSearch,
} from "../studio/projectPaneThreads";
import type { SelectProjectThread } from "../studio/useProjectPaneSelection";
import { useHiddenAideRoute } from "../studio/hiddenAideRoute";
import { useChatsProjectRoute } from "../studio/chatsProjectRoute";
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
  const search = Route.useSearch();
  const { thread, checkout, threadEnvironment, restoreThread, increment } = search;
  const navigate = Route.useNavigate();
  // A hidden personal assistant (Settings → General) has no page: links, history
  // and reloads that name it land on Overview instead. Nothing is deleted.
  const aideHidden = useHiddenAideRoute(projectKey);
  // A machine's "No project" folder holds chats; it is not a project and has no page.
  // Until its machine's config arrives, a folder shaped like one shows nothing.
  const chatsRoute = useChatsProjectRoute(projectKey);
  const leave = aideHidden || chatsRoute === "chats";
  useEffect(() => {
    if (leave) void navigate({ to: "/", replace: true });
  }, [leave, navigate]);
  const selectThread = useCallback<SelectProjectThread>(
    (next, options) => {
      if (
        (next ?? undefined) === thread &&
        (options?.environmentId ?? undefined) === threadEnvironment &&
        options?.hash === undefined &&
        !restoreThread
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
    [navigate, projectKey, thread, checkout, threadEnvironment, restoreThread],
  );
  // A link made before the repository was known names the machine and path.
  const moveProjectKey = useCallback(
    (next: string) =>
      void navigate({
        to: "/projects/$projectKey",
        params: { projectKey: next },
        search: projectKeyMoveSearch({
          thread,
          checkout,
          threadEnvironment,
          restoreThread,
          increment,
        }),
        replace: true,
      }),
    [navigate, thread, checkout, threadEnvironment, restoreThread, increment],
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
  if (leave || chatsRoute === "pending") return null;
  return (
    <ProjectWorkspace
      projectKey={projectKey}
      checkoutKey={checkout ?? null}
      onSelectCheckout={selectCheckout}
      restoringThread={restoreThread ?? false}
      selectedThreadId={thread ?? null}
      selectedThreadEnvironmentId={threadEnvironment ?? null}
      onSelectThread={selectThread}
      onProjectKeyMoved={moveProjectKey}
    />
  );
}
