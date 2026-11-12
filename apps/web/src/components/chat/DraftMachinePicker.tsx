import { renderRich } from "../../i18n/rich";
import { useTx } from "../../i18n";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import {
  AuthOrchestrationOperateScope,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
} from "@specweave-studio/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderIcon,
  Link2Icon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
} from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore, type DraftId } from "~/composerDraftStore";
import { environmentCatalog } from "~/connection/catalog";
import { isThisMachineTarget } from "~/connection/desktopLocal";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useAideEnabled, useClientSettings, useLegacySidebarEnabled } from "~/hooks/useSettings";
import { PERSONAL_ASSISTANT_PER_MACHINE_LINE, visibleWithAide } from "~/studio/personalAssistant";
import { useProjectCoordinatorHandoff } from "~/hooks/useProjectCoordinatorHandoff";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import { useProjects } from "~/state/entities";
import {
  isArchivedMember,
  isOrdinaryProjectChoice,
  projectDestinationUnavailableReason,
} from "~/studio/projectListVisibility";
import {
  ADD_ROUTE_TEXT,
  addToMachineRoute,
  runOnMachineGroups,
  type RunOnMachineGroups,
} from "~/studio/addToMachine";
import { useMachineNicknames } from "~/studio/machineNickname";
import { useEnvironments, type EnvironmentPresentation } from "~/state/environments";
import { readEnvironmentScope, useEnvironmentsWithScope } from "~/state/session";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { machineLastSeenAt, useMachineLastSeenVersion } from "~/lib/machineLastSeen";
import {
  isThisMachineCatchingUp,
  lastSeenLabel,
  machineDetail,
  machineStatus,
} from "~/lib/machineStatus";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { RenameMachineDialog } from "../settings/RenameMachineDialog";
import { platformName } from "../settings/AccountJoinCard.logic";
import { ProjectLinkDialog, type ProjectLinkTarget } from "../studio/ProjectLinkDialog";
import { cn } from "~/lib/utils";
import { machineColorProps, useMachineIdentity } from "../../studio/machineIdentity";
import { AddToMachineDialog } from "./AddToMachineDialog";
import { DraftFolderCopy } from "./DraftFolderCopy";
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
  const tx = useTx();
  const { draftId, disabled, sendInFlightRef, onPendingChange } = props;
  const draft = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const composer = useComposerDraftStore((store) => store.getComposerDraft(draftId));
  const { environments } = useEnvironments();
  const permitted = useEnvironmentsWithScope(environments, AuthOrchestrationOperateScope);
  // A hidden personal assistant (Settings → General) is not offered as a destination.
  const aideEnabled = useAideEnabled();
  const catalogProjects = useProjects();
  const projects = useMemo(
    () => visibleWithAide(catalogProjects, aideEnabled),
    [catalogProjects, aideEnabled],
  );
  const legacy = useLegacySidebarEnabled();
  const coordinatorHandoff = useProjectCoordinatorHandoff();
  const grouping = useClientSettings(selectProjectGroupingSettings);
  const { scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const [open, setOpen] = useState(false);
  const [choosingEnvironmentId, setChoosingEnvironmentId] = useState<EnvironmentId | null>(null);
  const [view, setView] = useState<"machines" | "add" | "other" | "rename">("machines");
  const [addTarget, setAddTarget] = useState<{
    readonly source: EnvironmentProject;
    readonly environmentId: EnvironmentId;
  } | null>(null);
  // No Git remote: the folder copy review instead of a clone with nothing to clone from.
  const [copyTarget, setCopyTarget] = useState<{
    readonly source: EnvironmentProject;
    readonly environmentId: EnvironmentId;
    readonly seq: number;
  } | null>(null);
  const [linkTarget, setLinkTarget] = useState<{
    readonly project: EnvironmentProject;
    readonly candidate: ProjectLinkTarget;
  } | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    readonly environmentId: EnvironmentId;
    readonly hostLabel: string;
  } | null>(null);
  const nameOf = useMachineNicknames();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  useMachineLastSeenVersion();
  const [retrying, setRetrying] = useState<ReadonlySet<EnvironmentId>>(new Set());
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
    setView("machines");
    setError(null);
    onPendingChange(false);
  }, [draftId, draft?.environmentId, draft?.projectId, onPendingChange]);

  const activeEnvironment = environments.find(
    (item) => item.environmentId === draft?.environmentId,
  );
  const activeLabel = activeEnvironment
    ? nameOf(activeEnvironment.environmentId, activeEnvironment.label)
    : "Unavailable machine";
  const activeIsThisMachine = activeEnvironment
    ? isThisMachineTarget(activeEnvironment.entry)
    : false;
  const activeStatus = activeEnvironment
    ? machineStatus(
        activeEnvironment.connection,
        permitted.has(activeEnvironment.environmentId),
        activeIsThisMachine,
      )
    : null;
  const activeUnreachable = activeEnvironment
    ? activeEnvironment.connection.phase !== "connected"
    : true;
  // Only this machine catching up reads as busy; a stopped connection there
  // keeps the warning and says "Connection failed", never "Can't reach".
  const activeBusy =
    activeIsThisMachine &&
    activeEnvironment !== undefined &&
    isThisMachineCatchingUp(activeEnvironment.connection.phase);
  const locked = disabled || !draft || Boolean(draft.promotedTo);
  const attachmentsBlock = draftHasMachineBoundContent(composer);
  const activeProject = projects.find(
    (project) => project.environmentId === draft?.environmentId && project.id === draft.projectId,
  );
  // A named project groups machines by whether they have it; Scratch has no copies to group.
  const runOnProject =
    activeProject &&
    !isScratchProject(activeProject, scratchWorkspaceRootFor(activeProject.environmentId))
      ? activeProject
      : null;
  const groups = runOnProject
    ? runOnMachineGroups({
        active: runOnProject,
        environmentIds: environments.map((item) => item.environmentId),
        projects,
        logicalKey: (project) => deriveLogicalProjectKeyFromSettings(project, grouping),
      })
    : null;
  const choosingEnvironment = environments.find(
    (item) => item.environmentId === choosingEnvironmentId,
  );
  const destinationReason = choosingEnvironment
    ? draftMachineUnavailableReason(
        choosingEnvironment.connection.phase,
        permitted.has(choosingEnvironment.environmentId),
        isThisMachineTarget(choosingEnvironment.entry),
      )
    : null;
  // Only the person's own projects: no archived project, no project a check or agent made
  // for itself, and not the machine's "No project" folder, which has its own choice.
  const destinationProjects = projects.filter(
    (project) =>
      project.environmentId === choosingEnvironmentId &&
      isOrdinaryProjectChoice(project, scratchWorkspaceRootFor),
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
            isThisMachineTarget(environment.entry),
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
      // A dialog can start a switch with the menu closed; reopen it so the reason shows.
      if (result.status === "blocked") {
        setError(result.reason);
        setOpen(true);
      } else if (result.status === "selected") setOpen(false);
    } catch {
      if (requestRef.current === request) {
        setError("Could not switch machine. Your draft is unchanged.");
        setOpen(true);
      }
    } finally {
      if (requestRef.current === request) {
        requestRef.current = null;
        setPending(false);
        onPendingChange(false);
      }
    }
  }

  // A retry asks the machine's supervisor to try now. The row's own status
  // reports the outcome, so the marker only lasts until the attempt settles.
  async function retryMachine(environmentId: EnvironmentId) {
    setRetrying((current) => new Set(current).add(environmentId));
    try {
      await retryEnvironment(environmentId);
    } finally {
      setRetrying((current) => {
        const next = new Set(current);
        next.delete(environmentId);
        return next;
      });
    }
  }

  function chooseMachine(environmentId: EnvironmentId, known?: EnvironmentProject) {
    setError(null);
    if (attachmentsBlock && environmentId !== draft?.environmentId) {
      setError(MACHINE_ATTACHMENT_BLOCK_REASON);
      return;
    }
    const matching =
      known ??
      (activeProject &&
        projects.find(
          (project) =>
            project.environmentId === environmentId &&
            !isArchivedMember(project) &&
            deriveLogicalProjectKeyFromSettings(project, grouping) ===
              deriveLogicalProjectKeyFromSettings(activeProject, grouping),
        ));
    if (matching && environmentId !== draft?.environmentId) {
      void select({ environmentId, projectId: matching.id });
    } else {
      setChoosingEnvironmentId(environmentId);
    }
  }

  function openProjects(environmentId: EnvironmentId) {
    setError(null);
    if (attachmentsBlock && environmentId !== draft?.environmentId) {
      setError(MACHINE_ATTACHMENT_BLOCK_REASON);
      return;
    }
    setChoosingEnvironmentId(environmentId);
  }

  function closeMenuFor(action: () => void) {
    setOpen(false);
    setView("machines");
    action();
  }

  // One row per machine. A usable machine runs `onChoose`; an unreachable one
  // retries its connection; one that needs the user (sign in, access, update)
  // links to the fix instead of sitting disabled.
  function machineRow(
    environment: EnvironmentPresentation,
    options: {
      readonly onChoose: () => void;
      /** Replaces "Connected" when the machine is usable, for copies and actions. */
      readonly usableText?: string | undefined;
      /** A short action word kept visible at the row's end, such as "Link". */
      readonly usableAction?: string | undefined;
      readonly selectable?: boolean | undefined;
    },
  ) {
    const thisMachine = isThisMachineTarget(environment.entry);
    const canOperate = permitted.has(environment.environmentId);
    const reason = draftMachineUnavailableReason(
      environment.connection.phase,
      canOperate,
      thisMachine,
    );
    const status = machineStatus(environment.connection, canOperate, thisMachine);
    const isRetrying = retrying.has(environment.environmentId);
    const name = nameOf(environment.environmentId, environment.label);
    // The system it reported, so a person can pick a Mac for simulator or Xcode work.
    const os = platformName(environment.serverConfig?.environment.platform.os);
    // This machine is only busy, so it has no "last seen" or failure to explain.
    const detail = machineDetail(
      reason && !thisMachine
        ? lastSeenLabel(machineLastSeenAt(environment.environmentId), Date.now())
        : null,
      status.reason,
    );
    const retryRow = Boolean(reason) && status.retryable;
    const fixRow =
      Boolean(reason) &&
      !retryRow &&
      environment.connection.phase !== "connecting" &&
      !(thisMachine && isThisMachineCatchingUp(environment.connection.phase));
    const statusText = isRetrying
      ? "Retrying…"
      : !reason && options.usableText
        ? options.usableText
        : status.text;
    const body = (
      <>
        <EnvironmentMachineIcon
          aria-hidden
          kind={resolveEnvironmentMachineKind(environment.serverConfig ?? null)}
          className="size-4 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="block truncate">{name}</span>
            {os && (
              <span className="shrink-0 text-xs text-muted-foreground" data-machine-os>
                {os}
              </span>
            )}
          </span>
          <span
            className={`block truncate text-xs ${retryRow || fixRow ? "text-warning-foreground" : "text-muted-foreground"}`}
            title={statusText}
          >
            {statusText}
          </span>
          {detail && !isRetrying && (
            <span className="block truncate text-xs text-muted-foreground" title={detail}>
              {detail}
            </span>
          )}
        </span>
        {options.selectable !== false && environment.environmentId === draft?.environmentId && (
          <CheckIcon aria-label={tx("Selected machine")} />
        )}
        {retryRow && !isRetrying && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <RotateCwIcon aria-hidden className="size-3" />
            {tx("Retry")}
          </span>
        )}
        {fixRow && <span className="shrink-0 text-xs text-muted-foreground">{tx("Fix")}</span>}
        {!reason && !isRetrying && options.usableAction && (
          <span className="shrink-0 text-xs text-muted-foreground">{options.usableAction}</span>
        )}
      </>
    );
    if (fixRow)
      return (
        <MenuItem
          key={environment.environmentId}
          render={<Link to="/settings/connections" />}
          aria-label={`Fix ${name}: ${status.text}`}
          data-machine-status={environment.connection.phase}
        >
          {body}
        </MenuItem>
      );
    return (
      <MenuItem
        key={environment.environmentId}
        closeOnClick={false}
        disabled={(Boolean(reason) && !retryRow) || pending || locked || isRetrying}
        onClick={() =>
          retryRow ? void retryMachine(environment.environmentId) : options.onChoose()
        }
        {...(retryRow ? { "aria-label": `Retry ${name}: ${status.text}` } : {})}
        data-machine-status={environment.connection.phase}
      >
        {body}
      </MenuItem>
    );
  }

  const backRow = (
    <MenuItem
      closeOnClick={false}
      onClick={() => {
        setError(null);
        setView("machines");
      }}
    >
      <ArrowLeftIcon aria-hidden /> {tx("Machines")}
    </MenuItem>
  );
  const environmentById = new Map(environments.map((item) => [item.environmentId, item]));

  function machinesView() {
    const rows = groups
      ? groups.withProject.flatMap(({ environmentId, project }) => {
          const environment = environmentById.get(environmentId);
          return environment
            ? [machineRow(environment, { onChoose: () => chooseMachine(environmentId, project) })]
            : [];
        })
      : environments.map((environment) =>
          machineRow(environment, { onChoose: () => chooseMachine(environment.environmentId) }),
        );
    return (
      <>
        <MenuGroup>
          <MenuGroupLabel>
            {runOnProject ? `Machines with ${runOnProject.title}` : tx("Run this draft on")}
          </MenuGroupLabel>
          {rows}
          {runOnProject?.workspaceSettings?.kind === "personal" && (
            <p className="max-w-64 px-2 py-1 text-muted-foreground text-xs">
              {tx(PERSONAL_ASSISTANT_PER_MACHINE_LINE)}
            </p>
          )}
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
              {props.autoEnvironmentLabel ?? tx("Auto balance matching projects")}
            </MenuItem>
          )}
        </MenuGroup>
        <MenuSeparator />
        {groups && groups.addable.length > 0 && (
          <MenuItem closeOnClick={false} disabled={locked} onClick={() => setView("add")}>
            <PlusIcon aria-hidden />
            {tx("Add to another machine…")}
            <ChevronRightIcon aria-hidden className="ms-auto" />
          </MenuItem>
        )}
        {groups && (
          <MenuItem closeOnClick={false} disabled={locked} onClick={() => setView("other")}>
            <FolderIcon aria-hidden />
            {tx("Another project or no project")}
            <ChevronRightIcon aria-hidden className="ms-auto" />
          </MenuItem>
        )}
        <MenuItem closeOnClick={false} onClick={() => setView("rename")}>
          <PencilIcon aria-hidden />
          {tx("Rename a machine")}
          <ChevronRightIcon aria-hidden className="ms-auto" />
        </MenuItem>
      </>
    );
  }

  function addView(project: EnvironmentProject, addable: RunOnMachineGroups["addable"]) {
    return (
      <MenuGroup>
        {backRow}
        <MenuGroupLabel>
          {renderRich(tx("Add {title} to"), { title: project.title })}
        </MenuGroupLabel>
        {addable.flatMap(({ environmentId, copy }) => {
          const environment = environmentById.get(environmentId);
          if (!environment) return [];
          return [
            machineRow(environment, {
              selectable: false,
              // AC-02: the path can be long, so "Link" sits apart and never truncates.
              usableText: copy
                ? `Has a copy at ${copy.workspaceRoot}`
                : ADD_ROUTE_TEXT[addToMachineRoute(project)],
              usableAction: copy ? "Link" : undefined,
              onChoose: () =>
                closeMenuFor(() =>
                  copy
                    ? setLinkTarget({
                        project,
                        candidate: { environmentId, projectId: copy.id },
                      })
                    : addToMachineRoute(project) === "copy"
                      ? setCopyTarget((previous) => ({
                          source: project,
                          environmentId,
                          seq: (previous?.seq ?? 0) + 1,
                        }))
                      : setAddTarget({ source: project, environmentId }),
                ),
            }),
          ];
        })}
      </MenuGroup>
    );
  }

  function otherView() {
    return (
      <MenuGroup>
        {backRow}
        <MenuGroupLabel>{tx("Choose a project on")}</MenuGroupLabel>
        {environments.map((environment) =>
          machineRow(environment, {
            selectable: false,
            onChoose: () => openProjects(environment.environmentId),
          }),
        )}
      </MenuGroup>
    );
  }

  function renameView() {
    return (
      <MenuGroup>
        {backRow}
        <MenuGroupLabel>{tx("Rename a machine")}</MenuGroupLabel>
        {environments.map((environment) => {
          const name = nameOf(environment.environmentId, environment.label);
          return (
            <MenuItem
              key={environment.environmentId}
              onClick={() =>
                closeMenuFor(() =>
                  setRenameTarget({
                    environmentId: environment.environmentId,
                    hostLabel: environment.label,
                  }),
                )
              }
              aria-label={`Rename ${name}`}
            >
              <EnvironmentMachineIcon
                aria-hidden
                kind={resolveEnvironmentMachineKind(environment.serverConfig ?? null)}
                className="size-4 shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{name}</span>
                {name !== environment.label && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {environment.label}
                  </span>
                )}
              </span>
              <PencilIcon aria-hidden className="size-3" />
            </MenuItem>
          );
        })}
      </MenuGroup>
    );
  }

  function projectsView(environment: EnvironmentPresentation) {
    const name = nameOf(environment.environmentId, environment.label);
    return (
      <MenuGroup>
        <MenuItem
          closeOnClick={false}
          onClick={() => {
            setChoosingEnvironmentId(null);
            setView("machines");
          }}
        >
          <ArrowLeftIcon aria-hidden /> {tx("Machines")}
        </MenuItem>
        <MenuGroupLabel>{renderRich(tx("Project on {name}"), { name: name })}</MenuGroupLabel>
        {!destinationReason &&
          runOnProject &&
          !destinationProjects.some(
            (project) =>
              deriveLogicalProjectKeyFromSettings(project, grouping) ===
              deriveLogicalProjectKeyFromSettings(runOnProject, grouping),
          ) && (
            <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
              {renderRich(
                tx(
                  "No active checkout of {title} is saved on {name}. Choose another project or No project. Your draft stays here until you choose.",
                ),
                { title: runOnProject.title, name: name },
              )}
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
        {scratchWorkspaceRootFor(environment.environmentId) !== null && (
          <MenuItem
            closeOnClick={false}
            disabled={pending || locked || Boolean(destinationReason)}
            onClick={() =>
              void select({ environmentId: environment.environmentId, projectId: null })
            }
          >
            {tx("No project")}
          </MenuItem>
        )}
        {!destinationProjects.length &&
          scratchWorkspaceRootFor(environment.environmentId) === null && (
            <p className="px-2 py-2 text-sm text-muted-foreground">
              {tx("No project is available on this machine.")}
            </p>
          )}
      </MenuGroup>
    );
  }

  const activeKind = resolveEnvironmentMachineKind(activeEnvironment?.serverConfig ?? null);
  // The Run on chip wears the target machine's color before anything is sent.
  const activeIdentity = useMachineIdentity(
    activeEnvironment?.environmentId ?? null,
    activeEnvironment?.label,
  );

  return (
    <div className="min-w-0 px-3 pt-2" data-draft-machine-picker="">
      <Menu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setChoosingEnvironmentId(null);
            setView("machines");
          }
        }}
      >
        <MenuTrigger
          render={<ComposerControl />}
          aria-label={`Run on: ${activeLabel}${activeUnreachable && activeStatus ? `, ${activeStatus.text}` : ""}${props.autoEnvironmentLabel ? `, ${props.autoEnvironmentLabel}` : ""}`}
          data-composer-shortcut="composer.host"
          data-composer-context-control
          disabled={locked}
          {...machineColorProps(activeIdentity)}
          className={cn("max-w-full justify-start", activeIdentity && "machine-chip font-semibold")}
          {...(activeEnvironment && activeLabel !== activeEnvironment.label
            ? { title: activeEnvironment.label }
            : {})}
        >
          <EnvironmentMachineIcon
            aria-hidden
            kind={activeIdentity?.icon ?? activeKind}
            className="size-4 shrink-0"
          />
          <span className="shrink-0 font-normal">{tx("Run on")}</span>
          <span className="min-w-0 truncate">{activeLabel}</span>
          {activeUnreachable && (
            <span
              className={`shrink-0 text-xs ${activeBusy ? "text-muted-foreground" : "text-warning-foreground"}`}
              data-draft-machine-unreachable={activeBusy ? undefined : ""}
              data-draft-machine-busy={activeBusy ? "" : undefined}
            >
              {activeIsThisMachine
                ? activeStatus?.text
                : activeStatus?.retryable
                  ? tx("Can't reach")
                  : (activeStatus?.text ?? tx("Not saved"))}
            </span>
          )}
          {props.autoEnvironmentLabel && (
            <span className="shrink-0 text-xs text-muted-foreground">{tx("Auto")}</span>
          )}
          <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
        </MenuTrigger>
        <MenuPopup
          align="start"
          className="w-[min(22rem,calc(100vw-2rem))]"
          {...composerFloatingLayerProps}
        >
          {choosingEnvironment
            ? projectsView(choosingEnvironment)
            : view === "add" && runOnProject && groups
              ? addView(runOnProject, groups.addable)
              : view === "other"
                ? otherView()
                : view === "rename"
                  ? renameView()
                  : machinesView()}
          {pending && (
            <p role="status" className="px-2 py-2 text-sm text-muted-foreground">
              {tx("Preparing machine…")}
            </p>
          )}
          {error && (
            <p role="alert" className="px-2 py-2 text-sm text-destructive-foreground">
              {error}
            </p>
          )}
          <MenuSeparator />
          <MenuItem render={<Link to="/settings/connections" />}>
            <Link2Icon aria-hidden />
            {tx("Connect machines…")}
          </MenuItem>
        </MenuPopup>
      </Menu>
      {addTarget && (
        <AddToMachineDialog
          open
          onOpenChange={(next) => {
            if (!next) setAddTarget(null);
          }}
          source={addTarget.source}
          destinationEnvironmentId={addTarget.environmentId}
          onAdded={(target) => {
            setAddTarget(null);
            void select(target);
          }}
        />
      )}
      {copyTarget && (
        <DraftFolderCopy
          key={`${copyTarget.source.environmentId}:${copyTarget.source.id}`}
          project={copyTarget.source}
          machine={copyTarget.environmentId}
          seq={copyTarget.seq}
          onClose={() => setCopyTarget(null)}
        />
      )}
      {linkTarget && (
        <ProjectLinkDialog
          open
          onOpenChange={(next) => {
            if (!next) setLinkTarget(null);
          }}
          project={linkTarget.project}
          initialCandidate={linkTarget.candidate}
          onLinked={() => void select(linkTarget.candidate)}
        />
      )}
      <RenameMachineDialog
        environmentId={renameTarget?.environmentId ?? null}
        hostLabel={renameTarget?.hostLabel ?? ""}
        open={renameTarget !== null}
        onOpenChange={(next) => {
          if (!next) setRenameTarget(null);
        }}
      />
    </div>
  );
}
