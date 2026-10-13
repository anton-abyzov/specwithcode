import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { type ThreadId } from "@specweave-studio/contracts";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { derivePhysicalProjectKey } from "../../logicalProject";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { isHostedStaticApp } from "../../hostedPairing";
import {
  useClientSettings,
  useClientSettingsHydrationStatus,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import {
  coordinatorMachineKey,
  resolveCoordinatorMachine,
} from "../../studio/projectCoordinatorMachine";
import { type SelectProjectThread } from "../../studio/useProjectPaneSelection";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";
import { isElectron } from "../../env";

import { ProjectWorkspaceSurface } from "./ProjectWorkspaceSurface";
export function findProjectGroup<
  G extends {
    projectKey: string;
    memberProjects: ReadonlyArray<Parameters<typeof derivePhysicalProjectKey>[0]>;
  },
>(groups: ReadonlyArray<G>, projectKey: string): G | undefined {
  return (
    groups.find((g) => g.projectKey === projectKey) ??
    groups.find((g) => g.memberProjects.some((m) => derivePhysicalProjectKey(m) === projectKey))
  );
}

export function ProjectWorkspace({
  projectKey: requestedKey,
  checkoutKey = null,
  onSelectCheckout,
  selectedThreadId = null,
  onSelectThread,
  onProjectKeyMoved,
}: {
  projectKey: string;
  /** Exact checkout carried by a project link; never a cross-machine fallback. */
  checkoutKey?: string | null;
  onSelectCheckout?: (key: string) => void;
  /** The thread open in the right panel; the route keeps it in the URL. */
  selectedThreadId?: ThreadId | null;
  onSelectThread?: SelectProjectThread;
  /** The project's group key changed since the link was made; the route replaces the URL. */
  onProjectKeyMoved?: (projectKey: string) => void;
}) {
  // Without a route to hold it (tests, embedding), the open thread is plain state.
  const [localSelected, setLocalSelected] = useState<ThreadId | null>(null);
  const selected = onSelectThread ? selectedThreadId : localSelected;
  const setSelected: SelectProjectThread = onSelectThread ?? setLocalSelected;
  const groups = useSettingsProjectGroups();
  const projects = useProjects();
  const group = findProjectGroup(groups, requestedKey);
  // Saved choices and threads are keyed by the group's current key.
  const projectKey = group?.projectKey ?? requestedKey;
  useEffect(() => {
    if (projectKey !== requestedKey) onProjectKeyMoved?.(projectKey);
  }, [projectKey, requestedKey, onProjectKeyMoved]);
  const members = group?.memberProjects ?? [];
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const { isReady: environmentCatalogReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedMachines = useClientSettings((settings) => settings.projectCoordinatorMachines);
  const updateClientSettings = useUpdateClientSettings();
  // Before settings load the saved choices read as empty, and a pick would replace them all.
  const machinesLoaded = useClientSettingsHydrationStatus() === "ready";
  // The coordinator runs on the chosen checkout's machine; the choice is saved per project.
  const { member, savedMachineMissing } = checkoutKey
    ? {
        member: members.find((candidate) => coordinatorMachineKey(candidate) === checkoutKey),
        savedMachineMissing: !members.some(
          (candidate) => coordinatorMachineKey(candidate) === checkoutKey,
        ),
      }
    : resolveCoordinatorMachine({
        members,
        saved: savedMachines[projectKey],
        primaryEnvironmentId,
      });
  // The thread open when the checkout changed belongs to the old machine. The
  // panel closes, and until the URL catches up the new checkout does not see it,
  // or it would send the person to that machine's full page.
  const [leftThread, setLeftThread] = useState<ThreadId | null>(null);
  if (leftThread !== null && selected !== leftThread) setLeftThread(null);
  const paneSelected = selected === leftThread ? null : selected;
  const currentMachine = member ? coordinatorMachineKey(member) : null;
  const chooseMachine = (key: string) => {
    if (key !== currentMachine && selected !== null) {
      setLeftThread(selected);
      setSelected(null, { replace: true });
    }
    onSelectCheckout?.(key);
    void updateClientSettings({
      projectCoordinatorMachines: { ...savedMachines, [projectKey]: key },
    });
  };
  const project = member
    ? projects.find((p) => p.environmentId === member.environmentId && p.id === member.id)
    : null;
  // A project window starts on this route before its hosts have answered, so
  // the project is not missing yet, only not loaded. The saved host list can
  // arrive before this computer's own host is registered, which is too early
  // to tell either.
  const hostsAnswered =
    shellsBootstrapped &&
    environmentCatalogReady &&
    (isHostedStaticApp() || primaryEnvironmentId !== null);
  // Until the hosts answer, a missing saved machine or unread choice may only be late.
  if ((!project || savedMachineMissing || !machinesLoaded) && !hostsAnswered)
    return (
      <SidebarInset className="h-dvh">
        <div className="project-surface flex min-h-0 flex-1 flex-col" aria-busy="true">
          <WorkspacePageHeader electron={isElectron}>Project workspace</WorkspacePageHeader>
          <div className="project-empty">
            <p>Loading project...</p>
            <Link to="/settings/projects">Manage projects</Link>
          </div>
        </div>
      </SidebarInset>
    );
  if (!project)
    return (
      <SidebarInset className="h-dvh">
        <div className="project-surface flex min-h-0 flex-1 flex-col">
          <WorkspacePageHeader electron={isElectron}>Project workspace</WorkspacePageHeader>
          <div className="project-empty">
            <h1>{checkoutKey ? "Linked checkout unavailable" : "Project unavailable"}</h1>
            <p>
              {checkoutKey
                ? "Connect the linked host, or choose an available checkout explicitly."
                : "Connect its host or select a registered project."}
            </p>
            {checkoutKey && onSelectCheckout && machinesLoaded
              ? members.map((checkout) => (
                  <button
                    key={coordinatorMachineKey(checkout)}
                    type="button"
                    className="project-control"
                    onClick={() => chooseMachine(coordinatorMachineKey(checkout))}
                  >
                    Use {checkout.environmentLabel ?? checkout.environmentId} ·{" "}
                    {checkout.workspaceRoot}
                  </button>
                ))
              : null}
            <Link to="/settings/projects">Manage projects</Link>
          </div>
        </div>
      </SidebarInset>
    );
  return (
    <ProjectWorkspaceSurface
      key={`${project.environmentId}:${project.id}`}
      project={project}
      projectKey={projectKey}
      iconCheckouts={members}
      checkouts={members.map((m) => ({
        key: coordinatorMachineKey(m),
        machine: m.environmentLabel ?? m.environmentId,
        folder: m.workspaceRoot,
      }))}
      savedMachineMissing={savedMachineMissing}
      onCheckout={machinesLoaded ? chooseMachine : null}
      selected={paneSelected}
      setSelected={setSelected}
    />
  );
}
