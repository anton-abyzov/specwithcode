import type { DraftId } from "~/composerDraftStore";
import { useComposerDraftStore } from "~/composerDraftStore";
import {
  AuthOrchestrationOperateScope,
  resolveEnvironmentMachineKind,
  type ScopedProjectRef,
} from "@specweave-studio/contracts";
import { scopedProjectKey, scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import { FolderPlusIcon, MessageSquareDashedIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { projectIconColorClassName } from "~/projectIconColors";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings, useLegacySidebarEnabled } from "~/hooks/useSettings";
import { useProjectCoordinatorHandoff } from "~/hooks/useProjectCoordinatorHandoff";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { readEnvironmentScope } from "~/state/session";
import { toastManager } from "../ui/toast";
import {
  ineligibleProjectLabel,
  projectChoiceIneligibleReason,
  projectDestinationUnavailableReason,
} from "~/studio/projectListVisibility";
import {
  draftHasMachineBoundContent,
  draftMachineUnavailableReason,
  MACHINE_ATTACHMENT_BLOCK_REASON,
} from "./draftMachineSelection";

// Menu value for "No project"; real entries are keyed by logical project key.
const NO_PROJECT_VALUE = "no-project";

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
  readonly disabled?: boolean;
  readonly sendInFlightRef?: Readonly<{ current: boolean }>;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
  disabled = false,
  sendInFlightRef,
}: DraftHeroHeadlineProps) {
  const projects = useProjects();
  const legacy = useLegacySidebarEnabled();
  const coordinatorHandoff = useProjectCoordinatorHandoff();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  // A machine's "No project" folder stays, as its own item; archived projects and projects
  // a check or agent made for itself are not destinations.
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups.map((group) => ({
          ...group,
          memberProjects: group.memberProjects.filter((project) => {
            const reason = projectChoiceIneligibleReason(project, scratchWorkspaceRootFor);
            return reason === null || reason === "scratch";
          }),
        })),
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups, scratchWorkspaceRootFor],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  const shouldShowProjectMenu = canChooseProject;
  // The project that hosts threads without a project appears once, as the
  // "No project" item, not as a project row.
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    activeProjectRef?.environmentId ?? primaryEnvironmentId,
  );
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null && isScratchProject(activeProject, scratchWorkspaceRoot);
  // A draft whose project was since archived or made by a check keeps it in the heading;
  // the menu shows it as the current context, never as a destination.
  const unavailableReason =
    activeProject !== null &&
    !isScratchDraft &&
    !menuEntries.some(({ group }) => group.projectKey === activeProjectKey)
      ? projectChoiceIneligibleReason(activeProject, scratchWorkspaceRootFor)
      : null;

  // The picker can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again.
  const latestTargetRef = useRef({ draftId, activeProjectKey, scratchTargetEnvironmentId });
  useEffect(() => {
    latestTargetRef.current = { draftId, activeProjectKey, scratchTargetEnvironmentId };
  }, [activeProjectKey, scratchTargetEnvironmentId, draftId]);
  const latestProjects = useRef(projects);
  latestProjects.current = projects;
  // Project selection changes the target of the open draft in place. The
  // prompt stays in the same composer session, so the sidebar only gets a
  // draft row if the user later navigates away.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    if (!draftId || !session || session.promotedTo || disabled || sendInFlightRef?.current) {
      return false;
    }
    const environment = environments.find((entry) => entry.environmentId === project.environmentId);
    const reason =
      projectDestinationUnavailableReason(
        { environmentId: project.environmentId, projectId: project.id },
        latestProjects.current,
      ) ??
      (environment
        ? draftMachineUnavailableReason(
            environment.connection.phase,
            readEnvironmentScope(project.environmentId, AuthOrchestrationOperateScope),
          )
        : "This machine is no longer saved. Connect it again.");
    if (
      !reason &&
      !legacy &&
      !isScratchProject(project, scratchWorkspaceRootFor(project.environmentId))
    ) {
      void coordinatorHandoff(scopeProjectRef(project.environmentId, project.id));
      return false;
    }
    const attachmentBlock =
      session.environmentId !== project.environmentId &&
      draftHasMachineBoundContent(getComposerDraft(draftId));
    if (reason || attachmentBlock) {
      toastManager.add({
        type: "warning",
        title: "Could not change project",
        description: reason ?? MACHINE_ATTACHMENT_BLOCK_REASON,
      });
      return false;
    }
    latestTargetRef.current = {
      draftId,
      activeProjectKey: logicalProjectKey,
      scratchTargetEnvironmentId: project.environmentId,
    };
    const currentDraft = getComposerDraft(draftId);
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
      {
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
        ...(isScratchProject(project, scratchWorkspaceRootFor(project.environmentId))
          ? {
              envMode: "local",
              startFromOrigin: false,
              branch: null,
              worktreePath: null,
            }
          : {}),
      },
    );
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentSettings = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig?.settings;
      const defaultModelSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
    return true;
  };
  const startScratch = async (): Promise<boolean> => {
    const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
    if (
      scratchTargetEnvironmentId === null ||
      isScratchDraft ||
      !draftId ||
      !session ||
      session.promotedTo ||
      disabled ||
      sendInFlightRef?.current
    ) {
      return false;
    }
    const requested = { draftId, activeProjectKey, scratchTargetEnvironmentId };
    const project = await openScratchProject(scratchTargetEnvironmentId);
    const latest = latestTargetRef.current;
    if (
      !project ||
      useComposerDraftStore.getState().getDraftSession(draftId) !== session ||
      latest.draftId !== requested.draftId ||
      latest.activeProjectKey !== requested.activeProjectKey ||
      latest.scratchTargetEnvironmentId !== requested.scratchTargetEnvironmentId
    ) {
      return false;
    }
    return selectProject(
      project,
      deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
    );
  };

  const projectSelector = shouldShowProjectMenu ? (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            // The trigger's accessible name comes from its visible text (the
            // project title) so the hero sentence reads naturally: an
            // aria-label here would replace the title with an action phrase
            // mid-sentence and baffle screen-reader users.
            <MenuTrigger
              render={<InlineButton tone="picker" />}
              data-draft-project-trigger=""
              disabled={disabled}
              className="pointer-events-auto max-w-64 align-baseline"
            />
          }
        >
          <span className="min-w-0 truncate">
            {isScratchDraft ? "No project" : (activeProjectDisplayName ?? "Choose a project")}
          </span>
        </TooltipTrigger>
        {activeProjectDisplayName && !isScratchDraft ? (
          <TooltipPopup side="top">{activeProjectDisplayName}</TooltipPopup>
        ) : null}
      </Tooltip>
      <MenuPopup align="center" className="max-h-80 overflow-y-auto">
        <MenuRadioGroup
          value={isScratchDraft ? NO_PROJECT_VALUE : activeProjectKey}
          onValueChange={(value) => {
            if (value === NO_PROJECT_VALUE) {
              void startScratch();
              return;
            }
            const entry = projectEntryByKey.get(value as string);
            if (
              !entry ||
              (entry.targetProject.environmentId === activeProjectRef?.environmentId &&
                entry.targetProject.id === activeProjectRef.projectId)
            ) {
              return;
            }
            selectProject(entry.targetProject, entry.group.projectKey);
          }}
        >
          {scratchWorkspaceRoot === null ? null : (
            <MenuRadioItem value={NO_PROJECT_VALUE} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                {/* Boxed like ProjectFavicon so the label lines up with project rows. */}
                <span
                  aria-hidden="true"
                  className={`inline-flex size-4 shrink-0 ${projectIconColorClassName("gray")}`}
                >
                  <MessageSquareDashedIcon className="size-full" />
                </span>
                No project
              </span>
            </MenuRadioItem>
          )}
          {unavailableReason && activeProjectGroup ? (
            <MenuRadioItem value={activeProjectKey} disabled>
              <span className="flex min-w-0 items-center gap-2">
                <ProjectFavicon project={activeProjectGroup} className="size-4 shrink-0" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{activeProjectGroup.displayName}</span>
                  <span className="truncate text-muted-foreground text-xs">
                    {ineligibleProjectLabel(unavailableReason)}
                  </span>
                </span>
              </span>
            </MenuRadioItem>
          ) : null}
          {menuEntries.map(({ group }) => {
            return (
              <MenuRadioItem key={group.projectKey} value={group.projectKey} closeOnClick>
                <span className="flex min-w-0 items-center gap-2">
                  <ProjectFavicon project={group} className="size-4 shrink-0" />
                  <Tooltip>
                    <TooltipTrigger render={<span className="block min-w-0 truncate" />}>
                      {group.displayName}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{group.displayName}</TooltipPopup>
                  </Tooltip>
                  {showProjectEnvironments ? (
                    <ProjectEnvironmentBadge
                      group={group}
                      primaryEnvironmentId={primaryEnvironmentId}
                      machineByEnvironmentId={environmentMachineById}
                    />
                  ) : null}
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
        {projectPickerEntries.length > 0 ? <MenuSeparator /> : null}
        <MenuItem onClick={openAddProject}>
          <FolderPlusIcon />
          Add project
        </MenuItem>
      </MenuPopup>
    </Menu>
  ) : (
    <button
      type="button"
      onClick={openAddProject}
      className="pointer-events-auto inline cursor-pointer border-muted-foreground/35 border-b border-dotted text-muted-foreground transition-colors hover:border-muted-foreground/60 hover:text-muted-foreground focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
    >
      {activeProjectTitle ?? "Add a project"}
    </button>
  );

  // The composer hero is a sentence, so the heading's accessible name must be
  // a complete sentence too. The project picker is a control rendered inline
  // in the h1; without an explicit label its widget state bleeds into the
  // announced phrase.
  const headingLabel = isScratchDraft
    ? "What should we work on?"
    : hasResolvedProject
      ? `What should we build in ${activeProjectDisplayName}?`
      : canChooseProject
        ? `${activeProjectDisplayName ?? "Choose a project"} to start`
        : "Add a project to start";

  // One click out of the project, phrased as the alternative to the question
  // above it. Focus moves to the project picker once this line has gone.
  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const orStartWithoutProject =
    scratchWorkspaceRoot !== null && !isScratchDraft && (hasResolvedProject || canChooseProject) ? (
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              tone="muted"
              className="pointer-events-auto"
              onClick={() =>
                void startScratch().then((started) => {
                  if (started) {
                    document.querySelector<HTMLElement>("[data-draft-project-trigger]")?.focus();
                  }
                })
              }
            />
          }
        >
          or start without a project
        </TooltipTrigger>
        {noProjectShortcut ? <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup> : null}
      </Tooltip>
    ) : null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1
        aria-label={headingLabel}
        className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
      >
        {isScratchDraft ? (
          <>What should we work on?</>
        ) : hasResolvedProject ? (
          <>What should we build in {projectSelector}?</>
        ) : canChooseProject ? (
          <>{projectSelector} to start</>
        ) : (
          <>Add a project to start</>
        )}
      </h1>
      {/* Reserved whenever threads can skip a project, so the heading does not
          move. Without a project, the picker moves here to choose one. */}
      {scratchWorkspaceRoot === null ? null : (
        <p className="mt-2 flex h-6 items-center text-sm">
          {isScratchDraft ? projectSelector : orStartWithoutProject}
        </p>
      )}
    </div>
  );
}
