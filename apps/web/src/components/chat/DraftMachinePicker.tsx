import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, CheckIcon, ChevronDownIcon, LaptopIcon, Link2Icon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";

import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings, useLegacySidebarEnabled } from "~/hooks/useSettings";
import { useProjectCoordinatorHandoff } from "~/hooks/useProjectCoordinatorHandoff";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { useProjects } from "~/state/entities";
import {
  isArchivedMember,
  projectDestinationUnavailableReason,
} from "~/studio/projectListVisibility";
import { useEnvironments } from "~/state/environments";
import { readEnvironmentScope, useEnvironmentsWithScope } from "~/state/session";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  draftHasMachineBoundContent,
  draftMachineUnavailableReason,
  MACHINE_ATTACHMENT_BLOCK_REASON,
  selectDraftMachineTarget,
  type DraftMachineTarget,
} from "./draftMachineSelection";

interface Props {
  readonly draftId: DraftId;
  readonly disabled: boolean;
  readonly sendInFlightRef: Readonly<{ current: boolean }>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly autoEnvironmentLabel?: string | undefined;
  readonly onAutoEnvironment?: (() => void) | undefined;
}

/** A draft's machine is explicit even when its project is local-only or is not a Git repo. */
export function DraftMachinePicker(props: Props) {
  const { draftId, disabled, sendInFlightRef, onPendingChange } = props;
  const draft = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const composer = useComposerDraftStore((store) => store.getComposerDraft(draftId));
  const { environments } = useEnvironments();
  const permitted = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  const projects = useProjects();
  const legacy = useLegacySidebarEnabled();
  const coordinatorHandoff = useProjectCoordinatorHandoff();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const { scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const [open, setOpen] = useState(false);
  const [choosingEnvironmentId, setChoosingEnvironmentId] = useState<EnvironmentId | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<object | null>(null);
  const latest = useRef({ props, environments, projects, grouping });
  latest.current = { props, environments, projects, grouping };

  useLayoutEffect(() => {
    return () => {
      requestRef.current = null;
      onPendingChange(false);
    };
  }, [draftId, onPendingChange]);
  useLayoutEffect(() => {
    requestRef.current = null;
    setPending(false);
    setOpen(false);
    setChoosingEnvironmentId(null);
    setError(null);
    onPendingChange(false);
  }, [draftId, draft?.environmentId, draft?.projectId, onPendingChange]);

  const activeEnvironment = environments.find(
    (item) => item.environmentId === draft?.environmentId,
  );
  const activeLabel = activeEnvironment?.label ?? "Unavailable machine";
  const locked = disabled || !draft || Boolean(draft.promotedTo);
  const attachmentsBlock = draftHasMachineBoundContent(composer);
  const activeProject = projects.find(
    (project) => project.environmentId === draft?.environmentId && project.id === draft.projectId,
  );
  const choosingEnvironment = environments.find(
    (item) => item.environmentId === choosingEnvironmentId,
  );
  const destinationReason = choosingEnvironment
    ? draftMachineUnavailableReason(
        choosingEnvironment.connection.phase,
        permitted.has(choosingEnvironment.environmentId),
      )
    : null;
  const destinationProjects = projects.filter(
    (project) =>
      project.environmentId === choosingEnvironmentId &&
      !isArchivedMember(project) &&
      !isScratchProject(project, scratchWorkspaceRootFor(project.environmentId)),
  );

  async function select(target: DraftMachineTarget) {
    const request = {};
    requestRef.current = request;
    setError(null);
    setPending(true);
    onPendingChange(true);
    try {
      const result = await selectDraftMachineTarget({
        target,
        readDraft: () => useComposerDraftStore.getState().getDraftSession(draftId),
        readComposer: () => useComposerDraftStore.getState().getComposerDraft(draftId),
        isBlocked: () =>
          latest.current.props.disabled || latest.current.props.sendInFlightRef.current,
        isCurrentRequest: () =>
          requestRef.current === request && latest.current.props.draftId === draftId,
        unavailableReason: (resolved) => {
          const environment = latest.current.environments.find(
            (item) => item.environmentId === target.environmentId,
          );
          if (!environment) return "This machine is no longer saved. Connect it again.";
          const reason = draftMachineUnavailableReason(
            environment.connection.phase,
            readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope),
          );
          if (reason) return reason;
          return projectDestinationUnavailableReason(target, latest.current.projects, resolved);
        },
        resolveProject: async () => {
          const project =
            target.projectId === null
              ? await openScratchProject(target.environmentId, "Could not switch machine")
              : latest.current.projects.find(
                  (item) =>
                    item.environmentId === target.environmentId && item.id === target.projectId,
                );
          return project ? { ...project, projectId: project.id } : null;
        },
        commit: (project) => {
          if (
            !legacy &&
            !isScratchProject(project, scratchWorkspaceRootFor(project.environmentId))
          ) {
            void coordinatorHandoff(scopeProjectRef(project.environmentId, project.id));
            return;
          }
          useComposerDraftStore
            .getState()
            .setLogicalProjectDraftThreadId(
              deriveLogicalProjectKeyFromSettings(project, latest.current.grouping),
              scopeProjectRef(project.environmentId, project.id),
              draftId,
              {
                environmentSelection: "manual",
                loadBalancedEnvironmentId: null,
                // Scratch is a plain server-owned folder, including before Git status arrives.
                ...(target.projectId === null
                  ? {
                      envMode: "local",
                      startFromOrigin: false,
                      branch: null,
                      worktreePath: null,
                    }
                  : {}),
              },
            );
        },
      });
      if (requestRef.current !== request) return;
      if (result.status === "blocked") setError(result.reason);
      else if (result.status === "selected") setOpen(false);
    } catch {
      if (requestRef.current === request)
        setError("Could not switch machine. Your draft is unchanged.");
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        setPending(false);
        onPendingChange(false);
      }
    }
  }

  function chooseMachine(environmentId: EnvironmentId) {
    setError(null);
    if (attachmentsBlock && environmentId !== draft?.environmentId) {
      setError(MACHINE_ATTACHMENT_BLOCK_REASON);
      return;
    }
    const matching =
      activeProject &&
      projects.find(
        (project) =>
          project.environmentId === environmentId &&
          !isArchivedMember(project) &&
          deriveLogicalProjectKeyFromSettings(project, grouping) ===
            deriveLogicalProjectKeyFromSettings(activeProject, grouping),
      );
    if (matching && environmentId !== draft?.environmentId) {
      void select({ environmentId, projectId: matching.id });
    } else {
      setChoosingEnvironmentId(environmentId);
    }
  }

  return (
    <div className="min-w-0 px-3 pt-2" data-draft-machine-picker="">
      <Menu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setChoosingEnvironmentId(null);
        }}
      >
        <MenuTrigger
          render={<ComposerControl />}
          aria-label={`Machine: ${activeLabel}${props.autoEnvironmentLabel ? `, ${props.autoEnvironmentLabel}` : ""}`}
          data-composer-shortcut="composer.host"
          data-composer-context-control
          disabled={locked}
          className="max-w-full justify-start"
        >
          <LaptopIcon aria-hidden className="size-4 shrink-0" />
          <span className="shrink-0">Machine</span>
          <span className="min-w-0 truncate">{activeLabel}</span>
          {props.autoEnvironmentLabel && (
            <span className="shrink-0 text-xs text-muted-foreground">Auto</span>
          )}
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        </MenuTrigger>
        <MenuPopup
          align="start"
          className="w-[min(22rem,calc(100vw-2rem))]"
          {...composerFloatingLayerProps}
        >
          {choosingEnvironment ? (
            <MenuGroup>
              <MenuItem closeOnClick={false} onClick={() => setChoosingEnvironmentId(null)}>
                <ArrowLeftIcon aria-hidden /> Machines
              </MenuItem>
              <MenuGroupLabel>Project on {choosingEnvironment.label}</MenuGroupLabel>
              {!destinationReason &&
                activeProject &&
                !isScratchProject(
                  activeProject,
                  scratchWorkspaceRootFor(activeProject.environmentId),
                ) &&
                !destinationProjects.some(
                  (project) =>
                    deriveLogicalProjectKeyFromSettings(project, grouping) ===
                    deriveLogicalProjectKeyFromSettings(activeProject, grouping),
                ) && (
                  <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
                    No active checkout of {activeProject.title} is saved on{" "}
                    {choosingEnvironment.label}. Choose another project or No project. Your draft
                    stays here until you choose.
                  </p>
                )}
              {destinationReason && (
                <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
                  {destinationReason}
                </p>
              )}
              {destinationProjects.map((project) => (
                <MenuItem
                  key={project.id}
                  closeOnClick={false}
                  disabled={pending || locked || Boolean(destinationReason)}
                  onClick={() =>
                    void select({ environmentId: project.environmentId, projectId: project.id })
                  }
                >
                  <span className="min-w-0">
                    <span className="block truncate">{project.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {project.workspaceRoot}
                    </span>
                  </span>
                </MenuItem>
              ))}
              {scratchWorkspaceRootFor(choosingEnvironment.environmentId) !== null && (
                <MenuItem
                  closeOnClick={false}
                  disabled={pending || locked || Boolean(destinationReason)}
                  onClick={() =>
                    void select({
                      environmentId: choosingEnvironment.environmentId,
                      projectId: null,
                    })
                  }
                >
                  No project
                </MenuItem>
              )}
              {!destinationProjects.length &&
                scratchWorkspaceRootFor(choosingEnvironment.environmentId) === null && (
                  <p className="px-2 py-2 text-sm text-muted-foreground">
                    No project is available on this machine.
                  </p>
                )}
            </MenuGroup>
          ) : (
            <MenuGroup>
              <MenuGroupLabel>Run this draft on</MenuGroupLabel>
              {environments.map((environment) => {
                const reason = draftMachineUnavailableReason(
                  environment.connection.phase,
                  permitted.has(environment.environmentId),
                );
                return (
                  <MenuItem
                    key={environment.environmentId}
                    closeOnClick={false}
                    disabled={Boolean(reason) || pending || locked}
                    onClick={() => chooseMachine(environment.environmentId)}
                  >
                    <LaptopIcon aria-hidden className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{environment.label}</span>
                      <span className="block text-xs text-muted-foreground">
                        {reason ?? "Connected"}
                      </span>
                    </span>
                    {environment.environmentId === draft?.environmentId && (
                      <CheckIcon aria-label="Selected machine" />
                    )}
                  </MenuItem>
                );
              })}
              {props.onAutoEnvironment && (
                <MenuItem
                  disabled={locked || pending || attachmentsBlock}
                  onClick={() => {
                    const state = useComposerDraftStore.getState();
                    const currentDraft = state.getDraftSession(draftId);
                    if (
                      latest.current.props.disabled ||
                      latest.current.props.draftId !== draftId ||
                      latest.current.props.sendInFlightRef.current ||
                      pending ||
                      requestRef.current !== null ||
                      !currentDraft ||
                      currentDraft !== draft ||
                      currentDraft.promotedTo ||
                      draftHasMachineBoundContent(state.getComposerDraft(draftId))
                    )
                      return;
                    latest.current.props.onAutoEnvironment?.();
                  }}
                >
                  {props.autoEnvironmentLabel ?? "Auto balance matching projects"}
                </MenuItem>
              )}
            </MenuGroup>
          )}
          {pending && (
            <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
              Preparing machine…
            </p>
          )}
          {error && (
            <p role="alert" className="px-2 py-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <MenuSeparator />
          <MenuItem render={<Link to="/settings/connections" />}>
            <Link2Icon aria-hidden />
            Connect machines…
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
