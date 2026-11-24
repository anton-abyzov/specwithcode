import { useRememberProjectDestination } from "../../studio/projectReturnNavigation";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { projectExecutionScopes } from "../../studio/projectDomain";
import { ProjectHandoffRecovery } from "./ProjectHandoffRecovery";
import { ownSeatOfLinkedAssistant } from "./assistantEntries";
import { ConnectLinkedMachine } from "./ConnectLinkedMachine";
import { useEffect, useMemo, useState } from "react";
import { useTx } from "../../i18n";
import { Link } from "@tanstack/react-router";
import { type ThreadId } from "@specweave-studio/contracts";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import {
  derivePhysicalProjectKey,
  deriveLogicalProjectKey,
  deriveUnlinkedProjectKey,
  LOGICAL_PROJECT_KEY_PREFIX,
} from "../../logicalProject";
import { projectWorkspaceSearch } from "../../studio/projectPaneThreads";
import {
  useAllEnvironmentShellsBootstrapped,
  useEnvironmentShellLive,
  useProjects,
} from "../../state/entities";
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
  checkoutAnsweredMissing,
  checkoutKeyEnvironmentId,
  checkoutUnavailableReason,
  chooseCoordinatorView,
  coordinatorMachineKey,
  heldCheckoutKey,
  type CheckoutUnavailableReason,
  type HeldCheckout,
  orchestratorCopies,
  unloadedMachineRef,
  unloadedMachineRefs,
  UNCONFIRMED_COORDINATOR_PROBLEM,
  unconfirmedCoordinatorProblem,
} from "../../studio/projectCoordinatorMachine";
import { useLinkMachines } from "./useLinkMachines";
import { type SelectProjectThread } from "../../studio/useProjectPaneSelection";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { SidebarInset } from "../ui/sidebar";
import { Button } from "../ui/button";
import { isElectron } from "../../env";

import { ProjectWorkspaceSurface } from "./ProjectWorkspaceSurface";
import { KeptProjectPages } from "./KeptProjectPages";
import { MoveDialogHold } from "../../studio/moveDialogHold";
import { useRetiredMachineRecords } from "../settings/useReplacedMachineRecords";

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

type LinkedOfferMember = Parameters<typeof deriveUnlinkedProjectKey>[0];
const unlinkedKeyOf = (member: LinkedOfferMember) =>
  typeof member.workspaceRoot === "string" ? deriveUnlinkedProjectKey(member) : null;

/**
 * The linked projects to offer on a page whose checkout is not in its group, best
 * first: the one holding that exact checkout, then one sharing a logical project with
 * the group's copies, then one holding a copy of the same repository on the checkout's
 * machine. Unrelated projects on that machine are never offered.
 */
function linkedProjectOffers<
  G extends { projectKey: string; memberProjects: ReadonlyArray<LinkedOfferMember> },
>(input: {
  readonly groups: ReadonlyArray<G>;
  readonly group: G | undefined;
  readonly requestedKey: string;
  readonly checkoutKey: string | null;
}): Array<{ group: G; checkout: string | null }> {
  const { groups, group, requestedKey, checkoutKey } = input;
  const keyOf = (member: LinkedOfferMember) => `${member.environmentId}:${member.id}`;
  const machine = checkoutKey === null ? null : checkoutKeyEnvironmentId(checkoutKey);
  const ownKeys = new Set([requestedKey, ...(group ? [group.projectKey] : [])]);
  for (const member of group?.memberProjects ?? []) {
    const key = unlinkedKeyOf(member);
    if (key !== null) ownKeys.add(key);
  }
  const logicalIds = new Set(
    (group?.memberProjects ?? []).flatMap((member) => {
      const id = member.workspaceSettings?.logicalProject?.id;
      return id ? [id] : [];
    }),
  );
  const ranked: Array<{ group: G; checkout: string | null; rank: number }> = [];
  for (const candidate of groups) {
    if (candidate === group || !candidate.projectKey.startsWith(LOGICAL_PROJECT_KEY_PREFIX))
      continue;
    const members = candidate.memberProjects;
    const exact = checkoutKey === null ? undefined : members.find((m) => keyOf(m) === checkoutKey);
    const onMachine = members.find((m) => {
      const key = m.environmentId === machine ? unlinkedKeyOf(m) : null;
      return key !== null && ownKeys.has(key);
    });
    const sameLogical = members.some((m) => {
      const id = m.workspaceSettings?.logicalProject?.id;
      return id !== undefined && logicalIds.has(id);
    });
    const rank = exact ? 0 : sameLogical ? 1 : onMachine ? 2 : null;
    if (rank === null) continue;
    const checkout = exact ?? onMachine ?? null;
    ranked.push({ group: candidate, checkout: checkout ? keyOf(checkout) : null, rank });
  }
  return ranked
    .sort((a, b) => a.rank - b.rank)
    .map(({ group: offered, checkout }) => ({ group: offered, checkout }));
}

export function ProjectWorkspace({
  projectKey: requestedKey,
  checkoutKey = null,
  onSelectCheckout,
  selectedThreadId = null,
  selectedThreadEnvironmentId = null,
  restoringThread = false,
  onSelectThread,
  onProjectKeyMoved,
}: {
  projectKey: string;
  /**
   * Exact checkout carried by a project link; never a cross-machine fallback, except that
   * one its online machine answers it does not have is dropped for the group's own.
   */
  checkoutKey?: string | null;
  onSelectCheckout?: (key: string) => void;
  /** The thread open in the right panel; the route keeps it in the URL. */
  selectedThreadId?: ThreadId | null;
  selectedThreadEnvironmentId?: string | null;
  restoringThread?: boolean;
  onSelectThread?: SelectProjectThread;
  /** The project's group key changed since the link was made; the route replaces the URL. */
  onProjectKeyMoved?: (projectKey: string) => void;
}) {
  const tx = useTx();
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
  // The machine of a linked checkout, read to say why that checkout is not listed.
  const checkoutEnvironmentId = checkoutKey ? checkoutKeyEnvironmentId(checkoutKey) : null;
  const checkoutProjectsLive = useEnvironmentShellLive(checkoutEnvironmentId);
  const savedChoice: string | undefined = savedMachines[projectKey];
  const savedEnvironmentId = savedChoice ? checkoutKeyEnvironmentId(savedChoice) : null;
  const savedProjectsLive = useEnvironmentShellLive(savedEnvironmentId);
  // A checkout its machine answers it does not have is dropped (checkoutAnsweredMissing).
  const answeredMissing = (key: string | null | undefined, projectsLive: boolean) =>
    checkoutAnsweredMissing({ key, projects, environments, unreachable, projectsLive });
  const routeCheckout = answeredMissing(checkoutKey, checkoutProjectsLive) ? null : checkoutKey;
  // A saved choice whose machine still has a copy here is honored by that copy.
  const savedChoiceGone =
    answeredMissing(savedChoice, savedProjectsLive) &&
    !members.some((candidate) => candidate.environmentId === savedEnvironmentId);
  const lastChoice = savedChoiceGone ? undefined : savedChoice;
  useEffect(() => {
    if (!savedChoiceGone || !machinesLoaded) return;
    const kept = Object.entries(savedMachines).filter(([key]) => key !== projectKey);
    void updateClientSettings({ projectCoordinatorMachines: Object.fromEntries(kept) });
  }, [machinesLoaded, projectKey, savedChoiceGone, savedMachines, updateClientSettings]);
  // An open move dialog keeps its checkout on screen until it closes (see heldCheckoutKey).
  const [held, setHeld] = useState<HeldCheckout | null>(null);
  // The linked Percy opens on this window's own seat, so a new chat starts on the
  // machine the person sits at (1448 AC-20); other machines' chats are in its one list.
  const ownAssistantSeat = ownSeatOfLinkedAssistant(members, primaryEnvironmentId);
  const view = chooseCoordinatorView({
    members,
    checkoutKey: routeCheckout ?? heldCheckoutKey(held, projectKey, members),
    lastViewed: ownAssistantSeat ? coordinatorMachineKey(ownAssistantSeat) : lastChoice,
    primaryEnvironmentId,
    unreachable,
  });
  const { member, missing: savedMachineMissing, problem: ownershipProblem } = view;
  // A linked machine this device never synced has nothing to show: say so, never a stand-in.
  const unknownRef = unloadedMachineRef(members, routeCheckout ?? lastChoice);
  const nickname = useMachineNicknames();
  const checkoutName = (checkout: EnvironmentProject & { environmentLabel?: string | null }) =>
    nickname(checkout.environmentId, checkout.environmentLabel);
  // A machine's nickname or host label; null when this device knows neither.
  const machineName = (environmentId: string) => {
    const label = environments.find((item) => item.environmentId === environmentId)?.label;
    const name = nickname(environmentId, label);
    return label || name !== environmentId ? name : null;
  };
  const linkMachines = useLinkMachines();
  // The same retired records Settings uses, so a re-joined machine's old copy never leads.
  const retired = useRetiredMachineRecords();
  const unknownLabel = unknownRef
    ? (machineName(unknownRef.environmentId) ?? "That machine")
    : null;
  const unknownTitle = members[0]?.title ?? "This project";
  // The thread open when the checkout changed belongs to the old machine. The
  // panel closes, and until the URL catches up the new checkout does not see it,
  // or it would send the person to that machine's full page.
  const [leftThread, setLeftThread] = useState<ThreadId | null>(null);
  if (leftThread !== null && selected !== leftThread) setLeftThread(null);
  const paneSelected = selected === leftThread ? null : selected;
  const currentMachine = member ? coordinatorMachineKey(member) : null;
  const holdMoveDialog = useMemo(
    () => (open: boolean) =>
      setHeld(open && currentMachine ? { projectKey, checkout: currentMachine } : null),
    [projectKey, currentMachine],
  );
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
  // This outer component is the active page, outside the kept/hidden surfaces.
  // Resolve checkout identity even when a direct URL omitted it.
  useRememberProjectDestination(project && machinesLoaded && onSelectThread ? projectKey : null, {
    ...(selected
      ? {
          thread: selected,
          threadEnvironment: selectedThreadEnvironmentId ?? project?.environmentId ?? "",
        }
      : {}),
    ...(currentMachine ? { checkout: currentMachine } : {}),
    restoreThread: restoringThread,
  });
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
            <Button variant="outline" render={<Link to="/settings/projects" />}>
              Manage projects
            </Button>
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
            <h1>
              {unknownTitle} on {unknownLabel} cannot be opened from this window
            </h1>
            <p className="mt-2 max-w-prose text-muted-foreground">
              This app has no connection to {unknownLabel}, so it has nothing of {unknownTitle} from
              there to show. Nothing is shown in its place, and nothing typed here is sent to
              another machine.
            </p>
            <ConnectLinkedMachine environmentId={unknownRef.environmentId} label={unknownLabel} />
            <div className="mt-5 flex flex-wrap items-center gap-2">
              {onSelectCheckout && machinesLoaded
                ? members.map((checkout) => (
                    <Button
                      key={coordinatorMachineKey(checkout)}
                      variant="outline"
                      size="sm"
                      onClick={() => chooseMachine(coordinatorMachineKey(checkout))}
                    >
                      Open {unknownTitle} on {checkoutName(checkout)}
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
  if (!project) {
    // Say why the linked checkout is not here, naming its machine.
    const unavailable =
      checkoutEnvironmentId === null
        ? null
        : checkoutUnavailableReason({
            environmentId: checkoutEnvironmentId,
            environments,
            unreachable,
            projectsLive: checkoutProjectsLive,
          });
    return (
      <SidebarInset className="h-dvh">
        <div
          className="project-surface flex min-h-0 flex-1 flex-col"
          data-checkout-unavailable={unavailable ?? undefined}
        >
          <WorkspacePageHeader electron={isElectron}>Project workspace</WorkspacePageHeader>
          <div className="project-empty">
            <h1>{checkoutKey ? "Linked checkout unavailable" : "Project unavailable"}</h1>
            <p data-checkout-unavailable-reason={unavailable ?? undefined}>
              {unavailable && checkoutEnvironmentId !== null
                ? checkoutUnavailableText(
                    unavailable,
                    machineName(checkoutEnvironmentId) ?? "That machine",
                  )
                : "Connect its host or select a registered project."}
            </p>
            {checkoutKey
              ? linkedProjectOffers({ groups, group, requestedKey, checkoutKey }).map(
                  ({ group: linked, checkout }) => (
                    <Button
                      key={linked.projectKey}
                      size="sm-multiline"
                      className="max-w-full"
                      data-linked-project-offer={linked.projectKey}
                      render={
                        <Link
                          to="/projects/$projectKey"
                          params={{ projectKey: linked.projectKey }}
                          search={projectWorkspaceSearch(null, checkout)}
                        />
                      }
                    >
                      <span className="min-w-0 wrap-anywhere">
                        Open {linked.displayName} (linked)
                      </span>
                    </Button>
                  ),
                )
              : null}
            {members[0] ? (
              <ProjectHandoffRecovery
                scopes={projectExecutionScopes(members[0], members)}
                members={members}
              />
            ) : null}
            {checkoutKey && onSelectCheckout && machinesLoaded
              ? members.map((checkout) => (
                  <Button
                    key={coordinatorMachineKey(checkout)}
                    variant="outline"
                    size="sm-multiline"
                    className="max-w-full"
                    onClick={() => chooseMachine(coordinatorMachineKey(checkout))}
                  >
                    {/* A full folder path wraps inside the button instead of widening the page. */}
                    <span className="min-w-0 wrap-anywhere">
                      Use {checkoutName(checkout)} · {checkout.workspaceRoot}
                    </span>
                  </Button>
                ))
              : null}
            <Button variant="outline" render={<Link to="/settings/projects" />}>
              Manage projects
            </Button>
          </div>
        </div>
      </SidebarInset>
    );
  }
  const pageKey = `${project.environmentId}:${project.id}`;
  // Named and translated here: the page below shows a problem as the sentence it is given.
  const unconfirmedText = unconfirmedCoordinatorProblem(member ? checkoutName(member) : "");
  const page = (
    <MoveDialogHold value={holdMoveDialog}>
      <ProjectWorkspaceSurface
        key={pageKey}
        project={project}
        projectKey={projectKey}
        iconCheckouts={members}
        loadedProjects={projects}
        selectedEnvironmentId={
          onSelectThread ? selectedThreadEnvironmentId : localSelectedEnvironment
        }
        ownershipProblem={
          ownershipProblem === UNCONFIRMED_COORDINATOR_PROBLEM
            ? // A member that cannot be named gets the same sentence without a name.
              member
              ? tx(unconfirmedText.text, unconfirmedText.values)
              : tx(UNCONFIRMED_COORDINATOR_PROBLEM)
            : ownershipProblem
        }
        checkouts={orchestratorCopies(members, checkoutName, linkMachines.startReady, retired)}
        unknownMachines={unloadedMachineRefs(members).map((ref) => ({
          key: `${ref.environmentId}:${ref.projectId}`,
          machine: machineName(ref.environmentId) ?? "Linked machine",
        }))}
        savedMachineMissing={savedMachineMissing}
        onCheckout={machinesLoaded ? chooseMachine : null}
        restoringThread={restoringThread}
        selected={paneSelected}
        setSelected={setSelected}
      />
    </MoveDialogHold>
  );
  return (
    <KeptProjectPages
      pageKey={pageKey}
      page={page}
      isLive={(key) => projects.some((p) => `${p.environmentId}:${p.id}` === key)}
    />
  );
}

function checkoutUnavailableText(reason: CheckoutUnavailableReason, machine: string): string {
  switch (reason) {
    case "host-offline":
      return `${machine} is offline. Its projects show again when it reconnects.`;
    case "host-refused":
      return `This device cannot connect to ${machine}. Check it under Settings > Machines.`;
    case "host-unknown":
      return "This device is not paired with the machine that holds this checkout.";
    case "host-loading":
      return `${machine} has not answered yet. Its projects show once it connects.`;
    case "not-registered":
      return `${machine} is online, but this checkout is no longer part of this project.`;
  }
}
