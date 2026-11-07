import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@specweave-studio/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentScopeAccess } from "../../state/session";
import { chooseCoordinatorView } from "../../studio/projectCoordinatorMachine";
import {
  closeInPlaceProjectSettings,
  type InPlaceProjectSettings,
  useInPlaceProjectSettings,
} from "../../studio/projectSettingsRequests";
import { projectWorkspace } from "../../studio/projectWorkspace";
import { useUnreachableHosts } from "../../studio/unreachableHosts";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { findProjectGroup } from "./ProjectWorkspace";
import { ProjectWorkspaceSettings } from "./ProjectWorkspaceSettings";
import { isProjectSettingsTab } from "./projectSettingsSearch.logic";

/**
 * Project settings opened from the shortcut or search on a page that is not the
 * project's own, such as a chat: the dialog opens over that page, which keeps its
 * thread and scroll. The project page opens its own dialog instead.
 */
export function InPlaceProjectSettingsHost() {
  const request = useInPlaceProjectSettings();
  const groups = useSettingsProjectGroups();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const unreachable = useUnreachableHosts();
  const savedMachines = useClientSettings((settings) => settings.projectCoordinatorMachines);
  // A request belongs to the page it was made on: one still loading when the person
  // moves on never opens over the next page.
  const pathname = useLocation({ select: (location) => location.pathname });
  useEffect(() => closeInPlaceProjectSettings, [pathname]);
  if (request === null) return null;
  const group = findProjectGroup(groups, request.projectKey);
  const members = group?.memberProjects ?? [];
  const projectKey = group?.projectKey ?? request.projectKey;
  const { member } = chooseCoordinatorView({
    members,
    checkoutKey: null,
    lastViewed: savedMachines[projectKey],
    primaryEnvironmentId,
    unreachable,
  });
  const project = member
    ? projects.find((p) => p.environmentId === member.environmentId && p.id === member.id)
    : undefined;
  if (!project) return null;
  return (
    <InPlaceProjectSettingsDialog
      key={`${project.environmentId}:${project.id}`}
      project={project}
      projectKey={projectKey}
      members={members}
      request={request}
    />
  );
}

function InPlaceProjectSettingsDialog({
  project,
  projectKey,
  members,
  request,
}: {
  project: EnvironmentProject;
  projectKey: string;
  members: readonly EnvironmentProject[];
  request: InPlaceProjectSettings;
}) {
  const navigate = useNavigate();
  const environment = useEnvironment(project.environmentId);
  const connected = environment?.connection.phase === "connected";
  const canOperate = useEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope);
  const operateAccess = useEnvironmentScopeAccess(
    project.environmentId,
    AuthOrchestrationOperateScope,
  );
  const query = useEnvironmentQuery(
    projectWorkspace.read({
      environmentId: project.environmentId,
      input: { projectId: project.id },
    }),
  );
  const snapshot = query.data;
  const coordinatorId = snapshot?.settings.coordinatorThreadId ?? null;
  const coordinatorRef = useMemo(
    () => (coordinatorId ? scopeThreadRef(project.environmentId, coordinatorId) : null),
    [project.environmentId, coordinatorId],
  );
  const coordinator = useThreadShell(coordinatorRef);
  if (!snapshot) return null;
  const target = request.target;
  const tab = target && isProjectSettingsTab(target.tab) ? target.tab : "general";
  return (
    <ProjectWorkspaceSettings
      project={project}
      coordinatorThreadModel={coordinator?.modelSelection ?? null}
      iconCheckouts={members}
      projectKey={projectKey}
      snapshot={snapshot}
      initialTab={tab}
      initialRow={target?.row ?? null}
      focusName={target === null}
      onClose={closeInPlaceProjectSettings}
      onSaved={query.refresh}
      onOpenThread={(threadId) => {
        closeInPlaceProjectSettings();
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: project.environmentId, threadId },
        });
      }}
      canOperate={canOperate && connected}
      accessNotice={
        !connected
          ? "This machine is not connected. Changes can be made once it reconnects."
          : operateAccess === "unknown"
            ? "Checking this connection's access…"
            : undefined
      }
      onDeleted={() => {
        closeInPlaceProjectSettings();
        void navigate({ to: "/" });
      }}
    />
  );
}
