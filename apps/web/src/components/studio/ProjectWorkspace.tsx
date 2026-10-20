import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { projectExecutionScopes } from "../../studio/projectDomain";
import { ProjectHandoffRecovery } from "./ProjectHandoffRecovery";
import { Activity, type ReactElement, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { type ThreadId } from "@specweave-studio/contracts";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { derivePhysicalProjectKey, deriveLogicalProjectKey } from "../../logicalProject";
import { useAllEnvironmentShellsBootstrapped, useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useUnreachableHosts } from "../../studio/unreachableHosts";
import { useMachineNicknames } from "../../studio/machineNickname";
import { isHostedStaticApp } from "../../hostedPairing";
import {
  useClientSettings,
  useClientSettingsHydrationStatus,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import {
  chooseCoordinatorView,
  coordinatorMachineKey,
  orchestratorCopies,
  unloadedMachineRef,
  unloadedMachineRefs,
} from "../../studio/projectCoordinatorMachine";
import { useLinkMachines } from "./useLinkMachines";
import { type SelectProjectThread } from "../../studio/useProjectPaneSelection";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { isElectron } from "../../env";

import { ProjectWorkspaceSurface } from "./ProjectWorkspaceSurface";

/** Recently visited project pages stay mounted, hidden, so switching back only shows them. */
export const KEPT_PROJECT_PAGES = 3;
type KeptPage = { key: string; page: ReactElement };
export function findProjectGroup<
  G extends {
    projectKey: string;
    memberProjects: ReadonlyArray<Parameters<typeof derivePhysicalProjectKey>[0]>;
  },
>(groups: ReadonlyArray<G>, projectKey: string): G | undefined {
  return (
    groups.find((g) => g.projectKey === projectKey) ??
    groups.find((g) => g.memberProjects.some((m) => derivePhysicalProjectKey(m) === projectKey)) ??
    groups
      .filter((g) =>
        g.memberProjects.some(
          (m) =>
            "repositoryIdentity" in m &&
            deriveLogicalProjectKey({
              ...m,
              workspaceSettings: undefined,
            } as EnvironmentProject) === projectKey,
        ),
      )
      .filter((_g, _index, matches) => matches.length === 1)[0]
  );
}

export function ProjectWorkspace({
  projectKey: requestedKey,
  checkoutKey = null,
  onSelectCheckout,
  selectedThreadId = null,
  selectedThreadEnvironmentId = null,
  onSelectThread,
  onProjectKeyMoved,
}: {
  projectKey: string;
  /** Exact checkout carried by a project link; never a cross-machine fallback. */
  checkoutKey?: string | null;
  onSelectCheckout?: (key: string) => void;
  /** The thread open in the right panel; the route keeps it in the URL. */
  selectedThreadId?: ThreadId | null;
  selectedThreadEnvironmentId?: string | null;
  onSelectThread?: SelectProjectThread;
  /** The project's group key changed since the link was made; the route replaces the URL. */
  onProjectKeyMoved?: (projectKey: string) => void;
}) {
  // Without a route to hold it (tests, embedding), the open thread is plain state.
  const [localSelected, setLocalSelected] = useState<ThreadId | null>(null);
  const [localSelectedEnvironment, setLocalSelectedEnvironment] = useState<string | null>(null);
  const selected = onSelectThread ? selectedThreadId : localSelected;
  const setSelected: SelectProjectThread =
    onSelectThread ??
    ((id, options) => {
      setLocalSelected(id);
      setLocalSelectedEnvironment(options?.environmentId ?? null);
    });
  const groups = useSettingsProjectGroups();
  const projects = useProjects();
  // State, not a ref read while rendering: the React Compiler then optimizes this
  // page, and the workspace below it keeps its props between renders.
  const [routeAnchor, setRouteAnchor] = useState<{
    requestedKey: string;
    environmentId: string;
    projectId: string;
  } | null>(null);
  const anchor = routeAnchor?.requestedKey === requestedKey ? routeAnchor : null;
  // Promotion from repository grouping to a domain ID must follow this checkout,
  // even if another unrelated registration still owns the old repository key.
  const group = anchor
    ? groups.find((candidate) =>
        candidate.memberProjects.some(
          (member) =>
            member.environmentId === anchor.environmentId && member.id === anchor.projectId,
        ),
      )
    : findProjectGroup(groups, requestedKey);
  // Saved choices and threads are keyed by the group's current key.
  const projectKey = group?.projectKey ?? requestedKey;
  useEffect(() => {
    if (projectKey !== requestedKey) onProjectKeyMoved?.(projectKey);
  }, [projectKey, requestedKey, onProjectKeyMoved]);
  const members = group?.memberProjects ?? [];
  const shellsBootstrapped = useAllEnvironmentShellsBootstrapped();
  const { isReady: environmentCatalogReady, environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedMachines = useClientSettings((settings) => settings.projectCoordinatorMachines);
  const updateClientSettings = useUpdateClientSettings();
  // Before settings load the saved choices read as empty, and a pick would replace them all.
  const machinesLoaded = useClientSettingsHydrationStatus() === "ready";
  // Which machine's orchestrator is shown. Viewing reads that machine's server and
  // never moves a thread or a coordinator; the last view is saved per project.
  const unreachable = useUnreachableHosts();
  const view = chooseCoordinatorView({
    members,
    checkoutKey,
    lastViewed: savedMachines[projectKey],
    primaryEnvironmentId,
    unreachable,
  });
  const { member, missing: savedMachineMissing, problem: ownershipProblem } = view;
  // A linked machine this device never synced has nothing to show: say so, never a stand-in.
  const unknownRef = unloadedMachineRef(members, checkoutKey ?? savedMachines[projectKey]);
  const nickname = useMachineNicknames();
  const checkoutName = (checkout: EnvironmentProject & { environmentLabel?: string | null }) =>
    nickname(checkout.environmentId, checkout.environmentLabel);
  // A machine's nickname or host label; null when this device knows neither.
  const machineName = (environmentId: string) => {
    const label = environments.find((item) => item.environmentId === environmentId)?.label;
    const name = nickname(environmentId, label);
    return label || name !== environmentId ? name : null;
  };
  const unknownLabel = unknownRef
    ? (machineName(unknownRef.environmentId) ?? "That machine")
    : null;
  const linkMachines = useLinkMachines();
  // The thread open when the checkout changed belongs to the old machine. The
  // panel closes, and until the URL catches up the new checkout does not see it,
  // or it would send the person to that machine's full page.
  const [leftThread, setLeftThread] = useState<ThreadId | null>(null);
  const [kept, setKept] = useState<readonly KeptPage[]>([]);
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
  if (
    member &&
    (anchor === null ||
      anchor.environmentId !== member.environmentId ||
      anchor.projectId !== member.id)
  )
    setRouteAnchor({ requestedKey, environmentId: member.environmentId, projectId: member.id });
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
  if ((!project || savedMachineMissing || unknownRef || !machinesLoaded) && !hostsAnswered)
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
  if (unknownRef && unknownLabel)
    return (
      <SidebarInset className="h-dvh">
        <div className="project-surface flex min-h-0 flex-1 flex-col" data-orchestrator-unknown="">
          <WorkspacePageHeader electron={isElectron}>Project workspace</WorkspacePageHeader>
          <div className="project-empty">
            <h1>{unknownLabel}'s orchestrator: Unknown</h1>
            <p className="mt-2 max-w-prose text-muted-foreground">
              {unknownLabel} is unreachable and this device has no synced copy of its orchestrator.
              Nothing is shown in its place, and nothing typed here is sent to another machine.
            </p>
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {onSelectCheckout && machinesLoaded
                ? members.map((checkout) => (
                    <Button
                      key={coordinatorMachineKey(checkout)}
                      variant="outline"
                      size="sm"
                      onClick={() => chooseMachine(coordinatorMachineKey(checkout))}
                    >
                      View {checkoutName(checkout)}'s orchestrator
                    </Button>
                  ))
                : null}
              <Link
                to="/settings/projects"
                className="ms-2 text-sm underline-offset-2 hover:underline"
              >
                Manage projects
              </Link>
            </div>
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
            {members[0] ? (
              <ProjectHandoffRecovery
                scopes={projectExecutionScopes(members[0], members)}
                members={members}
              />
            ) : null}
            {checkoutKey && onSelectCheckout && machinesLoaded
              ? members.map((checkout) => (
                  <button
                    key={coordinatorMachineKey(checkout)}
                    type="button"
                    className="project-control"
                    onClick={() => chooseMachine(coordinatorMachineKey(checkout))}
                  >
                    Use {checkoutName(checkout)} · {checkout.workspaceRoot}
                  </button>
                ))
              : null}
            <Link to="/settings/projects">Manage projects</Link>
          </div>
        </div>
      </SidebarInset>
    );
  const pageKey = `${project.environmentId}:${project.id}`;
  const page = (
    <ProjectWorkspaceSurface
      key={pageKey}
      project={project}
      projectKey={projectKey}
      iconCheckouts={members}
      selectedEnvironmentId={
        onSelectThread ? selectedThreadEnvironmentId : localSelectedEnvironment
      }
      ownershipProblem={ownershipProblem}
      checkouts={orchestratorCopies(members, checkoutName, linkMachines.startReady)}
      unknownMachines={unloadedMachineRefs(members).map((ref) => ({
        key: `${ref.environmentId}:${ref.projectId}`,
        machine: machineName(ref.environmentId) ?? "Linked machine",
      }))}
      savedMachineMissing={savedMachineMissing}
      onCheckout={machinesLoaded ? chooseMachine : null}
      selected={paneSelected}
      setSelected={setSelected}
    />
  );
  // A page left for another project stays mounted under a hidden Activity: its
  // effects and subscriptions stop, its DOM and state stay, so coming back shows
  // it without rendering its conversation again. The conversation puts its
  // reader back itself (useConversationFollow).
  if (kept[0]?.key !== pageKey)
    setKept(
      [{ key: pageKey, page }, ...kept.filter((entry) => entry.key !== pageKey)].slice(
        0,
        KEPT_PROJECT_PAGES,
      ),
    );
  const hidden = kept.filter(
    (entry) =>
      entry.key !== pageKey && projects.some((p) => `${p.environmentId}:${p.id}` === entry.key),
  );
  // One keyed list, so a page keeps its instance as it moves between shown and
  // hidden. The shown page comes first, so lookups by ID such as the composer's
  // `#project-prompt` find it before a hidden page's copy.
  return [{ key: pageKey, page }, ...hidden].map((entry) => (
    <Activity key={entry.key} mode={entry.key === pageKey ? "visible" : "hidden"}>
      {entry.page}
    </Activity>
  ));
}
