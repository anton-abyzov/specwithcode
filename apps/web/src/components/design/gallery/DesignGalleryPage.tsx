/**
 * The `/design` page: wires the design RPCs of this machine into the gallery
 * view, and starts "Design from code" threads.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import { squashAtomCommandFailure } from "@specweave-studio/client-runtime/state/runtime";
import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  type DesignOwnerInput,
  type DesignSystemId,
  type DesignSummary,
  type EnvironmentId,
  type ProjectId,
} from "@specweave-studio/contracts";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useEscapeToGoBack } from "~/hooks/useNavigateBack";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings, useEnvironmentSettings } from "~/hooks/useSettings";
import { isElectron } from "~/env";
import { newMessageId, newThreadId } from "~/lib/utils";
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
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { design } from "~/studio/design";
import { buildThreadRouteParams } from "~/threadRoutes";

import { scheduledTaskDefaultModel } from "../../settings/scheduledTasksSettings.logic";
import { ScrollArea } from "../../ui/scroll-area";
import { SidebarInset } from "../../ui/sidebar";
import { toastManager } from "../../ui/toast";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../WorkspacePageContainer";
import { WorkspacePageHeader } from "../../WorkspacePageHeader";
import { DesignFromCodeDialog, type DesignFromCodeRequest } from "../DesignFromCodeDialog";
import { useCopyDesignSystem } from "../systems/DesignSystemPicker";
import type { GalleryProject } from "./DesignActions";
import { workerModelLabel } from "./designFromCode";
import { designLink, designRoute, type DesignRoute } from "./designLinks";
import { DesignGalleryView } from "./DesignGalleryView";
import { DesignThumbnail, NearViewport } from "./DesignThumbnail";
import { duplicateDesign, renameDesign, type Outcome as MenuOutcome } from "./designMenuActions";
import {
  galleryFilterFromSearch,
  gallerySearchFor,
  newDesignPresetFromSearch,
  ownerInputOf,
  withoutNewDesignSearch,
  type CreationKind,
  type DesignGallerySearch,
} from "./galleryModel";
import { NewDesignDialog, type NewDesignRequest } from "./NewDesignDialog";
import { connectionMessage, whenConnected } from "./whenConnected";
import { startDesignFromCode, type Outcome, type PendingDesign } from "./startDesignFromCode";

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

/** The card picture: the design's head revision, fetched once the card is near the viewport. */
function LiveThumbnail({
  environmentId,
  summary,
}: {
  environmentId: EnvironmentId;
  summary: DesignSummary;
}) {
  const owner = ownerInputOf(summary);
  const document = useEnvironmentQuery(
    design.get({ environmentId, input: { owner, designId: summary.ref.designId } }),
  );
  const systemId = document.data?.document.designSystem ?? null;
  const system = useEnvironmentQuery(
    systemId === null ? null : design.systemGet({ environmentId, input: { owner, systemId } }),
  );
  const current = document.data?.document ?? null;
  // A newer revision in the list than the one on screen means the picture is stale.
  const { refresh } = document;
  useEffect(() => {
    if (current !== null && current.revision < summary.revision) refresh();
  }, [current, refresh, summary.revision]);
  return (
    <DesignThumbnail
      className="h-full w-full"
      document={current}
      system={system.data?.system ?? null}
    />
  );
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
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, { reportFailure: false });
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
  const scratchRoot = scratchWorkspaceRootFor(environmentId);
  const projects = useMemo(
    () =>
      allProjects.filter(
        (project) =>
          project.environmentId === environmentId && project.workspaceRoot !== scratchRoot,
      ),
    [allProjects, environmentId, scratchRoot],
  );
  const galleryProjects: GalleryProject[] = useMemo(
    () =>
      projects
        .map((project) => ({
          id: project.id,
          title: project.title,
          projectKey: deriveLogicalProjectKeyFromSettings(project, groupingSettings),
        }))
        .toSorted((a, b) => a.title.localeCompare(b.title)),
    [groupingSettings, projects],
  );
  const systems = systemList.data?.systems ?? [];
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

  const openDialog = (kind: CreationKind) => {
    setPreset(null);
    setDialog(kind);
  };

  const refreshList = list.refresh;
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

  const filter = galleryFilterFromSearch(search, galleryProjects);

  const onDelete = async (summary: DesignSummary) => {
    const result = await removeDesign({
      environmentId,
      input: { owner: ownerInputOf(summary), designId: summary.ref.designId },
    });
    if (result._tag === "Failure") {
      return failureMessage(squashAtomCommandFailure(result), "The design was not deleted.");
    }
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

  const onCreateDesign = async (request: NewDesignRequest) => {
    const connection = await whenConnected(environmentId);
    if (!connection.ok) return connectionMessage(connection);
    const result = await createDesign({
      environmentId,
      input: {
        owner: request.owner,
        kind: request.kind,
        title: request.title,
        designSystem: request.designSystem,
      },
    });
    if (result._tag === "Failure") {
      return failureMessage(
        squashAtomCommandFailure(result),
        request.kind === "slides" ? "The slides were not created." : "The design was not created.",
      );
    }
    setDialog(null);
    refreshList();
    navigate(designRoute(request.owner, result.value.ref.designId));
    return null;
  };

  // A design an earlier "Start design" created; a retry reuses it instead of creating another.
  const [pending, setPending] = useState<PendingDesign | null>(null);
  const closeDialog = () => {
    setDialog(null);
    setPending(null);
  };

  const onStartFromCode = async (request: DesignFromCodeRequest) => {
    const project = projects.find((candidate) => candidate.id === request.projectId);
    const model = workerModel(request.projectId);
    if (project === undefined) return "Choose a project.";
    if (model === null)
      return "No provider is ready on this machine. Sign in to one in Settings > Providers.";
    // Queue behind the connection: without a session the create is refused unsent.
    const connection = await whenConnected(environmentId);
    if (!connection.ok) return connectionMessage(connection);
    const runtimeMode =
      resolveProjectSettings(settings, project.id, project).settings.defaultRuntimeMode ??
      "full-access";
    const outcome = <A,>(
      result: { _tag: "Success"; value: A } | { _tag: "Failure" },
      fallback: string,
    ): Outcome<A> =>
      result._tag === "Success"
        ? { ok: true, value: result.value }
        : {
            ok: false,
            message: failureMessage(squashAtomCommandFailure(result as never), fallback),
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
        startThread: async ({ threadId, title, prompt }) =>
          outcome(
            await startTurn({
              environmentId,
              input: {
                threadId,
                message: {
                  messageId: newMessageId(),
                  role: "user",
                  text: prompt,
                  attachments: [],
                },
                modelSelection: model,
                titleSeed: title,
                runtimeMode,
                interactionMode: "default",
                dispatchMode: "start",
                bootstrap: {
                  createThread: {
                    projectId: project.id,
                    title,
                    modelSelection: model,
                    runtimeMode,
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    createdAt: new Date().toISOString(),
                  },
                },
              },
            }),
            "The provider did not respond.",
          ),
      },
      {
        environmentId,
        project,
        designSystem: request.designSystem,
        brief: request.brief,
        systems,
        pending,
      },
    );
    refreshList();
    if (!result.ok) {
      setPending(result.pending);
      return result.pending === null
        ? result.message
        : `The design is saved, but its thread did not start (${result.message.replace(/\.$/, "")}). Press Start design to try again, or Open design to edit it yourself.`;
    }
    closeDialog();
    const threadRef = scopeThreadRef(environmentId, result.threadId);
    toastManager.add({
      type: "success",
      title: "Design thread started",
      description: `Working in ${project.title} on ${workerModelLabel(model, entries) ?? model.model}.`,
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
          // Design systems are created and reviewed in Settings.
          kind === "design-system"
            ? void navigateTo({ to: "/settings/design-systems" })
            : openDialog(kind)
        }
        onOpen={open}
        onCopy={onCopy}
        onDelete={onDelete}
        onCopyLink={onCopyLink}
        onRename={onRename}
        onDuplicate={(summary) => void onDuplicate(summary)}
        onOpenProject={onOpenProject}
        filter={filter}
        onFilterChange={(next) => onSearchChange(gallerySearchFor(next))}
      />
      {dialog === "design" || dialog === "slides" ? (
        <NewDesignDialog
          key={dialog}
          kind={dialog === "slides" ? "slides" : "design"}
          open
          onOpenChange={(next) => {
            if (next) return;
            setDialog(null);
            setPreset(null);
          }}
          {...(dialog === "design" && preset !== null
            ? { initialOwner: preset.owner, initialSystemId: preset.systemId }
            : {})}
          projects={galleryProjects}
          systems={systems}
          onCreate={onCreateDesign}
          onCopySystem={canOperate ? copySystem : null}
        />
      ) : null}
      {dialog === "design-from-code" ? (
        <DesignFromCodeDialog
          open
          onOpenChange={(next) => !next && closeDialog()}
          projects={galleryProjects}
          systems={systems}
          onCopySystem={canOperate ? copySystem : null}
          onOpenCreated={
            pending === null
              ? null
              : () => {
                  const { projectId, ref } = pending;
                  closeDialog();
                  navigate(designRoute({ kind: "project", projectId }, ref.designId));
                }
          }
          workerLabelFor={(projectId) => workerModelLabel(workerModel(projectId), entries)}
          connected={connected}
          onStart={onStartFromCode}
        />
      ) : null}
    </>
  );
}
