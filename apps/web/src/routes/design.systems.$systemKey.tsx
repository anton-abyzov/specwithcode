import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";

import { decodeSystemKey } from "~/components/design/designKey";
import { SystemMessage, SystemPage } from "~/components/design/systems/workspace/SystemPage";
import { SidebarInset } from "~/components/ui/sidebar";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";

export const Route = createFileRoute("/design/systems/$systemKey")({ component: SystemRoute });

function SystemRoute() {
  const { systemKey } = Route.useParams();
  const decoded = useMemo(() => decodeSystemKey(systemKey), [systemKey]);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash.replace(/^#/, "") });
  // The section in view is a view of the page, not history: it replaces the entry.
  const onHashChange = useCallback(
    (next: string) =>
      void navigate({
        to: ".",
        hash: next,
        replace: true,
        resetScroll: false,
        hashScrollIntoView: false,
      }),
    [navigate],
  );
  const projectId = decoded?.owner.kind === "project" ? decoded.owner.projectId : null;
  const project =
    projectId === null
      ? null
      : (projects.find(
          (candidate) =>
            candidate.id === projectId && candidate.environmentId === primaryEnvironmentId,
        ) ??
        projects.find((candidate) => candidate.id === projectId) ??
        null);
  const environmentId =
    decoded === null
      ? null
      : decoded.owner.kind === "project"
        ? (project?.environmentId ?? null)
        : primaryEnvironmentId;

  let body;
  if (decoded === null)
    body = (
      <SystemMessage title="This design system link is not valid">
        Open the design system again from its project's designs or from Settings.
      </SystemMessage>
    );
  else if (environmentId === null)
    body =
      decoded.owner.kind === "project" ? (
        <SystemMessage title="Project not on this machine">
          The design system's project is not open in the app here. Add the project, then open the
          design system again.
        </SystemMessage>
      ) : (
        <SystemMessage title="Connecting">Waiting for this Mac to connect.</SystemMessage>
      );
  else
    body = (
      <SystemPage
        key={`${environmentId}:${systemKey}`}
        environmentId={environmentId}
        owner={decoded.owner}
        systemId={decoded.systemId}
        hash={hash}
        onHashChange={onHashChange}
      />
    );

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {body}
    </SidebarInset>
  );
}
