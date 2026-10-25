/**
 * The `/design` page: wires the design RPCs of this machine into the gallery
 * view, and starts "Design from code" threads.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthAccessWriteScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  DesignError,
  type DesignOwnerInput,
  type DesignSystemId,
  type DesignSummary,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { useNavigate, useRouter } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings, useEnvironmentSettings } from "~/hooks/useSettings";
import { isElectron } from "~/env";
import { newThreadId } from "~/lib/utils";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { design } from "~/studio/design";
import { designSystemImport } from "~/studio/designSystemImport";
import {
  ineligibleProjectLabel,
  isScratchMember,
  projectChoiceIneligibleReason,
} from "~/studio/projectListVisibility";
import { buildThreadRouteParams } from "~/threadRoutes";

import { scheduledTaskDefaultModel } from "../../settings/scheduledTasksSettings.logic";
import { ScrollArea } from "../../ui/scroll-area";
import { SidebarInset } from "../../ui/sidebar";
import { toastManager } from "../../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../WorkspacePageContainer";
import { WorkspacePageHeader } from "../../WorkspacePageHeader";
import { DesignFromCodeDialog, type DesignFromCodeRequest } from "../DesignFromCodeDialog";
import { NO_PROVIDER_MESSAGE, waitingThreadModel } from "../projectThread";
import { useCopyDesignSystem } from "../systems/DesignSystemPicker";
import { useProjectThreadStarter } from "../useProjectThreadStarter";
import { designSystemsHref, FOLDER_MISSING, missingFolderProjects } from "./boardOwner";
import type { GalleryProject } from "./DesignActions";
import { workerModelLabel } from "./designFromCode";
import { useDeckImport } from "./deckImport";
import { designLink, designRoute, type DesignRoute } from "./designLinks";
import { DesignGalleryView } from "./DesignGalleryView";
import { NearViewport } from "./DesignThumbnail";
import { LiveThumbnail } from "./LiveThumbnail";
import { duplicateDesign, renameDesign, type Outcome as MenuOutcome } from "./designMenuActions";
import {
  byRecentActivity,
  newDesignPresetFromSearch,
  resolveScope,
  searchForScope,
  ownerInputOf,
  withoutNewDesignSearch,
  type CreationKind,
  type DesignGallerySearch,
} from "./galleryModel";
import { NewDesignDialog, type NewDesignRequest } from "./NewDesignDialog";
import { connectSubjectOf, useConnectDesign } from "./useConnectDesign";
import { connectionMessage, whenConnected } from "./whenConnected";
import type { FoundSystem } from "./foundSystems";
import {
  reuseOf,
  startDesignFromCode,
  type Outcome,
  type PendingDesign,
} from "./startDesignFromCode";
import { useRepositoryScans } from "./useRepositoryScans";

const isDesignError = Schema.is(DesignError);

const unavailableField = (reason: Parameters<typeof ineligibleProjectLabel>[0] | null) =>
  reason === null ? {} : { unavailable: ineligibleProjectLabel(reason) };

/** A current project a creation picker does not offer, shown as context it cannot pick. */
function unavailableContext(project: GalleryProject | null, purpose: "design" | "code") {
  if (project === null) return null;
  const reason =
    project.unavailable ??
    (purpose === "code" && project.kind === "personal" ? ineligibleProjectLabel("not-code") : null);
  return reason === null ? null : { id: project.id, title: project.title, reason };
}

const failureMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error && cause.message.trim() !== "" ? cause.message : fallback;

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The gallery; `search` is the `/design` URL, which `onSearchChange` replaces. */
export function DesignGalleryPage({
  search = {},
  onSearchChange = () => undefined,
}: {
  search?: DesignGallerySearch;
  onSearchChange?: (next: DesignGallerySearch) => void;
} = {}) {
  useEscapeToGoBack();
  const router = useRouter();
  const environmentId = usePrimaryEnvironmentId();
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const canWrite = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Design breadcrumb" className="min-w-0">
            <WorkspaceBreadcrumbItem current>
              <h1>Design</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="expanded">
            {environmentId === null ? (
              <p className="text-muted-foreground text-sm">Connect to this Mac to see designs.</p>
            ) : !canRead ? (
              <p className="text-muted-foreground text-sm">This window may not read designs.</p>
            ) : (
              <ConnectedGallery
                environmentId={environmentId}
                canWrite={canWrite}
                canOperate={canOperate}
                navigate={(route) => void router.navigate(route)}
                search={search}
                onSearchChange={onSearchChange}
              />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function ConnectedGallery({
  environmentId,
  canWrite,
  canOperate,
  navigate,
  search,
  onSearchChange,
}: {
  environmentId: EnvironmentId;
  canWrite: boolean;
  canOperate: boolean;
  navigate: (route: DesignRoute) => void;
  search: DesignGallerySearch;
  onSearchChange: (next: DesignGallerySearch) => void;
}) {
  const now = useNow(30_000);
  const navigateTo = useNavigate();
  const router = useRouter();
  const list = useEnvironmentQuery(
    design.list({ environmentId, input: { filter: { kind: "all" } } }),
  );
  const systemList = useEnvironmentQuery(
    design.systemList({ environmentId, input: { filter: { kind: "all" } } }),
  );
  const createDesign = useAtomCommand(design.create, { reportFailure: false });
  const copyDesign = useAtomCommand(design.copy, { reportFailure: false });
  const removeDesign = useAtomCommand(design.remove, { reportFailure: false });
  const applyDesign = useAtomCommand(design.apply, { reportFailure: false });
  const copySystem = useCopyDesignSystem(environmentId, systemList.refresh);
  const proposeSystem = useAtomCommand(designSystemImport.propose, { reportFailure: false });
  const importSystem = useAtomCommand(designSystemImport.confirm, { reportFailure: false });
  const scans = useRepositoryScans(environmentId);
  const startProjectThread = useProjectThreadStarter();
  const { scratchWorkspaceRootFor } = useScratchProject();
  const allProjects = useProjects();
  const settings = useEnvironmentSettings(environmentId);
  const groupingSettings = useClientSettings(selectProjectGroupingSettings);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.environmentId === environmentId &&
          !isScratchMember(project, scratchWorkspaceRootFor),
      ),
    [allProjects, environmentId, scratchWorkspaceRootFor],
  );
  const listProblems = list.data?.problems;
  // A project whose folder is gone keeps its name, but no picker offers it.
  const missingFolders = useMemo(
    () => missingFolderProjects(listProblems ?? [], projects),
    [listProblems, projects],
  );
  const galleryProjects: GalleryProject[] = useMemo(
    () =>
      projects
        .map((project) => {
          const missingFolder = missingFolders.get(project.id);
          const reason = projectChoiceIneligibleReason(project, scratchWorkspaceRootFor, "design");
          return {
            id: project.id,
            title: project.title,
            projectKey: deriveLogicalProjectKeyFromSettings(project, groupingSettings),
            icon: project,
            kind:
              project.workspaceSettings?.kind === "personal"
                ? ("personal" as const)
                : ("code" as const),
            updatedAt: project.updatedAt,
            ...(reason === null && missingFolder !== undefined
              ? { unavailable: FOLDER_MISSING }
              : unavailableField(reason)),
            ...(missingFolder === undefined ? {} : { missingFolder }),
          };
        })
        .toSorted((a, b) => a.title.localeCompare(b.title)),
    [groupingSettings, missingFolders, projects, scratchWorkspaceRootFor],
  );
  // What the creation pickers offer: the person's own projects, most recently active first.
  // Archived and automated projects keep their designs and names, but are never a choice.
  const designs = list.data?.designs;
  const choiceProjects = useMemo(
    () =>
      byRecentActivity(
        galleryProjects.filter((project) => project.unavailable === undefined),
        designs ?? [],
      ),
    [designs, galleryProjects],
  );
  const codeProjects = useMemo(
    () => choiceProjects.filter((project) => project.kind !== "personal"),
    [choiceProjects],
  );
  const systems = systemList.data?.systems ?? [];
  const systemsReady = systemList.data !== undefined || Boolean(systemList.error);
  const [dialog, setDialog] = useState<CreationKind | null>(null);
  // `?new=design` from Settings ("Use in a new design") opens New design once, preselected.
  const [preset, setPreset] = useState<{
    owner: DesignOwnerInput;
    systemId: DesignSystemId | null;
  } | null>(null);
  const waitingForProjects =
    search.owner !== undefined && search.owner !== "playground" && galleryProjects.length === 0;
  const presetTaken = useRef(false);
  useEffect(() => {
    if (search.new !== "design") {
      presetTaken.current = false;
      return;
    }
    if (presetTaken.current || waitingForProjects) return;
    presetTaken.current = true;
    setPreset(newDesignPresetFromSearch(search, galleryProjects));
    setDialog("design");
    onSearchChange(withoutNewDesignSearch(search));
  }, [galleryProjects, onSearchChange, search, waitingForProjects]);
  const workerModel = useCallback(
    (projectId: ProjectId) =>
      scheduledTaskDefaultModel(
        settings,
        projects.find((project) => project.id === projectId) ?? null,
        entries,
      ),
    [entries, projects, settings],
  );

  const scope = resolveScope(search);
  // A project chip makes the new design that project's.
  const scopedProject =
    scope.kind === "project"
      ? (galleryProjects.find((project) => project.id === scope.projectId) ?? null)
      : null;
  const openDialog = (kind: CreationKind) => {
    setPreset(
      scopedProject === null
        ? null
        : { owner: { kind: "project", projectId: scopedProject.id }, systemId: null },
    );
    setDialog(kind);
  };

  // Designs an earlier "Start design" created, per project; reopening the dialog or switching
  // back to the project reuses them instead of creating another.
  const [pendingByProject, setPendingByProject] = useState<ReadonlyMap<ProjectId, PendingDesign>>(
    () => new Map(),
  );
  const setPending = (projectId: ProjectId, next: PendingDesign | null) =>
    setPendingByProject((current) => {
      const map = new Map(current);
      if (next === null) map.delete(projectId);
      else map.set(projectId, next);
      return map;
    });

  const refreshList = list.refresh;
  // "Import PowerPoint…" from New slides or next to Slides; older servers hide it.
  const [importFile, setImportFile] = useState<File | null>(null);
  const deckImport = useDeckImport(environmentId, {
    onImported: () => {
      setDialog(null);
      setImportFile(null);
      refreshList();
    },
    open: (owner, designId) => navigate(designRoute(owner, designId)),
  });
  // "Connect to a project" moves a Playground design; the gallery stays and says where it went.
  const isOwner = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const connect = useConnectDesign({
    environmentId,
    owner: isOwner,
    designs,
    onMoved: ({ route, project }) => {
      refreshList();
      // Said in the page: a toast would sit over the search field and the view toggle.
      setMoved({ title: project.title, route });
    },
  });
  const [moved, setMoved] = useState<{ title: string; route: DesignRoute } | null>(null);
  const open = (summary: DesignSummary) =>
    navigate(designRoute(ownerInputOf(summary), summary.ref.designId));

  const onCopy = async (summary: DesignSummary, to: DesignOwnerInput) => {
    const result = await copyDesign({
      environmentId,
      input: { owner: ownerInputOf(summary), designId: summary.ref.designId, to },
    });
    if (result._tag === "Failure") {
      const message = failureMessage(
        squashAtomCommandFailure(result),
        "The design was not copied.",
      );
      toastManager.add({ type: "error", title: "Could not copy the design", description: message });
      return message;
    }
    refreshList();
    const copy = result.value;
    toastManager.add({
      type: "success",
      title: `Copied to ${to.kind === "playground" ? "your Playground" : (galleryProjects.find((p) => p.id === to.projectId)?.title ?? "the project")}`,
      actionProps: {
        children: "Open copy",
        onClick: () => navigate(designRoute(to, copy.ref.designId)),
      },
    });
    return null;
  };

  const asOutcome = <A,>(
    result: { _tag: "Success"; value: A } | { _tag: "Failure" },
    fallback: string,
  ): MenuOutcome<A> =>
    result._tag === "Success"
      ? { ok: true, value: result.value }
      : { ok: false, message: failureMessage(squashAtomCommandFailure(result as never), fallback) };

  const onRename = async (summary: DesignSummary, title: string) => {
    const problem = await renameDesign(
      async (input) =>
        asOutcome(await applyDesign({ environmentId, input }), "The title was not saved."),
      summary,
      title,
    );
    // A conflict means the list is behind the file; show the current title.
    refreshList();
    return problem;
  };

  const onDuplicate = async (summary: DesignSummary) => {
    const result = await duplicateDesign(
      {
        copy: async (input) =>
          asOutcome(await copyDesign({ environmentId, input }), "The design was not copied."),
        apply: async (input) =>
          asOutcome(await applyDesign({ environmentId, input }), "The copy was not renamed."),
      },
      summary,
    );
    if (!result.ok) {
      toastManager.add({
        type: "error",
        title: "Could not duplicate the design",
        description: result.message,
      });
      return;
    }
    refreshList();
    const owner = ownerInputOf(summary);
    toastManager.add({
      type: result.renameProblem === null ? "success" : "warning",
      title:
        result.renameProblem === null
          ? `Duplicated as “${result.title}”`
          : "Duplicated, but the copy keeps the same title",
      ...(result.renameProblem === null ? {} : { description: result.renameProblem }),
      actionProps: {
        children: "Open",
        onClick: () => navigate(designRoute(owner, result.ref.designId)),
      },
    });
  };

  const onOpenProject = (_summary: DesignSummary, projectKey: string) =>
    void navigateTo({ to: "/projects/$projectKey", params: { projectKey } });

  const onDelete = async (summary: DesignSummary) => {
    const result = await removeDesign({
      environmentId,
      input: { owner: ownerInputOf(summary), designId: summary.ref.designId },
    });
    if (result._tag === "Failure") {
      return failureMessage(squashAtomCommandFailure(result), "The design was not deleted.");
    }
    // A design "Start design" kept for a retry is gone: the next Start creates another.
    setPendingByProject((current) => {
      const kept = [...current].filter(
        ([, pending]) => pending.ref.designId !== summary.ref.designId,
      );
      return kept.length === current.size ? current : new Map(kept);
    });
    refreshList();
    return null;
  };

  const onCopyLink = (summary: DesignSummary) => {
    void writeTextToClipboard(designLink(ownerInputOf(summary), summary.ref.designId)).then(
      (copied) =>
        toastManager.add(
          copied
            ? { type: "success", title: "Link copied", timeout: 1500 }
            : { type: "error", title: "Could not copy the link" },
        ),
    );
  };

  const connected = useEnvironment(environmentId)?.connection.phase === "connected";

  // The review proposal for a system found in a repository: in memory on the server, listed
  // in Settings > Design systems, written only when the person imports it.
  const proposeFound =
    (projectId: ProjectId) =>
    async (found: FoundSystem): Promise<Outcome<{ readonly id: string }>> => {
      const result = await proposeSystem({
        environmentId,
        input: {
          owner: { kind: "project", projectId },
          from: { kind: "code", paths: found.paths.slice(0, 200), name: found.name },
        },
      });
      return result._tag === "Success"
        ? { ok: true, value: { id: result.value.id } }
        : {
            ok: false,
            message: failureMessage(squashAtomCommandFailure(result), "No proposal was made."),
          };
    };

  const onCreateDesign = async (request: NewDesignRequest) => {
    const connection = await whenConnected(environmentId);
    if (!connection.ok) return connectionMessage(connection);
    const found = request.owner.kind === "project" ? (request.found ?? null) : null;
    let reuse = null;
    let designSystem = request.designSystem;
    let importedName: string | null = null;
    if (found !== null && request.owner.kind === "project") {
      const proposed = await proposeFound(request.owner.projectId)(found);
      const proposalId = proposed.ok ? proposed.value.id : null;
      // Choosing a found system imports it: a proposal lives only in the server's memory, so a
      // design pointing at one loses its tokens after a restart and exports without them.
      // When the import fails the design still records the proposal it came from.
      if (proposalId !== null) {
        const imported = await importSystem({
          environmentId,
          input: { proposalId, excludeTokens: [], excludeComponents: [] },
        });
        if (imported._tag === "Success") {
          designSystem = imported.value.ref.systemId;
          importedName = found.name;
          systemList.refresh();
        }
      }
      reuse = reuseOf(found, proposalId, new Date().toISOString());
    }
    const result = await createDesign({
      environmentId,
      input: {
        owner: request.owner,
        kind: request.kind,
        title: request.title,
        designSystem,
        ...(reuse === null ? {} : { reuse }),
      },
    });
    if (result._tag === "Failure") {
      const failed = failureMessage(
        squashAtomCommandFailure(result),
        request.kind === "slides" ? "The slides were not created." : "The design was not created.",
      );
      // The import already happened; say so, so a retry picks the system by name.
      return importedName === null
        ? failed
        : `${failed} ${importedName} was imported as a design system and stays in the project.`;
    }
    setDialog(null);
    refreshList();
    navigate(designRoute(request.owner, result.value.ref.designId));
    return null;
  };

  const closeDialog = () => setDialog(null);
  const presetOwner = preset?.owner ?? null;
  const presetProject =
    presetOwner?.kind === "project"
      ? (galleryProjects.find((project) => project.id === presetOwner.projectId) ?? null)
      : null;

  const onStartFromCode = async (request: DesignFromCodeRequest) => {
    const project = projects.find((candidate) => candidate.id === request.projectId);
    if (project === undefined) return "Choose a project.";
    // Without a ready model the thread is created with no turn, its brief waiting in the composer.
    const model = workerModel(request.projectId);
    const waitingModel = model === null ? waitingThreadModel(settings, project, entries) : null;
    if (model === null && waitingModel === null) return NO_PROVIDER_MESSAGE;
    // Queue behind the connection: without a session the create is refused unsent.
    const connection = await whenConnected(environmentId);
    if (!connection.ok) return connectionMessage(connection);
    const runtimeMode =
      resolveProjectSettings(settings, project.id, project).settings.defaultRuntimeMode ??
      "full-access";
    const outcome = <A,>(
      result: { _tag: "Success"; value: A } | { _tag: "Failure" },
      fallback: string,
    ): Outcome<A> => {
      if (result._tag === "Success") return { ok: true, value: result.value };
      const cause = squashAtomCommandFailure(result as never);
      return {
        ok: false,
        message: failureMessage(cause, fallback),
        ...(isDesignError(cause)
          ? {
              code: cause.code,
              ...(cause.currentRevision === undefined
                ? {}
                : { currentRevision: cause.currentRevision }),
            }
          : {}),
      };
    };
    const result = await startDesignFromCode(
      {
        create: async (input) =>
          outcome(await createDesign({ environmentId, input }), "The design was not created."),
        apply: async (input) =>
          outcome(
            await applyDesign({ environmentId, input }),
            "The design could not be linked to its thread.",
          ),
        newThreadId,
        propose: proposeFound(project.id),
        startThread: async ({ threadId, title, prompt }) => {
          const started = await startProjectThread({
            environmentId,
            projectId: project.id,
            threadId,
            title,
            message: { text: prompt, images: [] },
            runtimeMode,
            model,
            waitingModel,
          });
          return started.ok ? { ok: true, value: null } : { ok: false, message: started.message };
        },
      },
      {
        environmentId,
        project,
        designSystem: request.designSystem,
        designSystemName: request.designSystemName ?? null,
        found: request.found ?? null,
        brief: request.brief,
        systems,
        pending: pendingByProject.get(project.id) ?? null,
      },
    );
    refreshList();
    if (!result.ok) {
      setPending(project.id, result.pending);
      return result.pending === null
        ? result.message
        : `Created the design, but its thread did not start: ${result.message.replace(/\.$/, "")}. ${model === null ? "Create design" : "Start design"} tries again with the same design, or open it to edit it yourself.`;
    }
    setPending(project.id, null);
    closeDialog();
    const threadRef = scopeThreadRef(environmentId, result.threadId);
    const selfBind = result.selfBind
      ? " The agent attaches the thread to the design as it starts."
      : "";
    toastManager.add({
      // Without a ready model the thread was created waiting, never started.
      ...(model === null
        ? {
            type: "info" as const,
            title: "Design created",
            description: `No provider is ready, so its thread in ${project.title} waits with your brief. Sign in to one in Settings > Providers, then press Send.${selfBind}`,
          }
        : {
            type: "success" as const,
            title: "Design thread started",
            description: `Working in ${project.title} on ${workerModelLabel(model, entries) ?? model.model}.${selfBind}`,
          }),
      actionProps: {
        children: "Open thread",
        onClick: () =>
          void navigateTo({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(threadRef),
          }),
      },
    });
    navigate(designRoute({ kind: "project", projectId: project.id }, result.ref.designId));
    return null;
  };

  return (
    <>
      <DesignGalleryView
        designs={list.data?.designs ?? (list.error ? [] : null)}
        error={list.error}
        problems={list.data?.problems ?? []}
        projects={galleryProjects}
        now={now}
        canWrite={canWrite}
        canOperate={canOperate}
        renderThumbnail={(summary) => (
          <NearViewport className="h-full w-full">
            <LiveThumbnail environmentId={environmentId} summary={summary} />
          </NearViewport>
        )}
        onCreate={(kind) =>
          // Design systems are created and reviewed in Settings; a board names its project.
          kind === "design-system"
            ? void router.navigate({ href: designSystemsHref(scopedProject) })
            : openDialog(kind)
        }
        onImportSlides={
          deckImport.available
            ? (file) => {
                setImportFile(file);
                openDialog("slides");
              }
            : null
        }
        onOpen={open}
        onCopy={onCopy}
        onDelete={onDelete}
        onCopyLink={onCopyLink}
        onRename={onRename}
        onDuplicate={(summary) => void onDuplicate(summary)}
        onOpenProject={onOpenProject}
        notice={
          moved === null
            ? null
            : {
                title: `Moved to ${moved.title}`,
                description: "Its files are now in the project's .specweave/design folder.",
                actionLabel: "Open",
                onAction: () => navigate(moved.route),
                onDismiss: () => setMoved(null),
              }
        }
        onOpenProjectPage={(projectKey) =>
          void navigateTo({ to: "/projects/$projectKey", params: { projectKey } })
        }
        onConnect={
          connect.available
            ? (summary, projectId) => connect.request(connectSubjectOf(summary), projectId)
            : null
        }
        scope={scope}
        onScopeChange={(next) => onSearchChange(searchForScope(next, search.group))}
        {...(search.group ? { grouping: search.group } : {})}
        onGroupingChange={(next) => {
          if (search.group !== undefined) onSearchChange({ ...search, group: next });
        }}
      />
      {dialog === "design" || dialog === "slides" ? (
        <NewDesignDialog
          key={`${dialog}-${importFile?.name ?? ""}`}
          kind={dialog === "slides" ? "slides" : "design"}
          open
          onOpenChange={(next) => {
            if (next) return;
            setDialog(null);
            setPreset(null);
            setImportFile(null);
          }}
          onImport={deckImport.available ? deckImport.importDeck : null}
          initialFile={importFile}
          {...(preset !== null
            ? { initialOwner: preset.owner, initialSystemId: preset.systemId }
            : {})}
          unavailable={unavailableContext(presetProject, "design")}
          projects={choiceProjects}
          systems={systems}
          systemsReady={systemsReady}
          scanFor={scans.stateFor}
          onScan={scans.request}
          onCreate={onCreateDesign}
          onCopySystem={canOperate ? copySystem : null}
        />
      ) : null}
      {dialog === "design-from-code" ? (
        <DesignFromCodeDialog
          open
          onOpenChange={(next) => !next && closeDialog()}
          projects={codeProjects}
          systems={systems}
          systemsReady={systemsReady}
          scanFor={scans.stateFor}
          onScan={scans.request}
          {...(scopedProject !== null ? { initialProjectId: scopedProject.id } : {})}
          unavailable={unavailableContext(scopedProject, "code")}
          onCopySystem={canOperate ? copySystem : null}
          hasCreated={(projectId) => pendingByProject.has(projectId)}
          onOpenCreated={(projectId) => {
            const created = pendingByProject.get(projectId);
            if (created === undefined) return;
            closeDialog();
            navigate(designRoute({ kind: "project", projectId }, created.ref.designId));
          }}
          workerLabelFor={(projectId) => workerModelLabel(workerModel(projectId), entries)}
          canWaitFor={(projectId) =>
            waitingThreadModel(
              settings,
              projects.find((project) => project.id === projectId) ?? null,
              entries,
            ) !== null
          }
          connected={connected}
          onStart={onStartFromCode}
        />
      ) : null}
      {connect.dialog}
      {deckImport.dialog}
    </>
  );
}
