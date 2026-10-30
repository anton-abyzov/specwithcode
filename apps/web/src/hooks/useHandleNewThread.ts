import { isScratchProject } from "@specweave-studio/client-runtime/state/projects";
import {
  enqueueProjectCoordinatorDraft,
  projectWorkspaceIntentText,
} from "../studio/projectCoordinatorDraft";
import { projectWorkspaceSearch } from "../studio/projectPaneThreads";
import { holdsSeparateClones } from "../lib/folderLayoutGuidance";
import { readNewThreadWorkspaceDefault } from "../lib/newThreadWorkspaceDefault";
import {
  readProjectFolderCheck,
  useProjectFolderCheckCommand,
} from "../studio/useProjectFolderHealth";
import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@specweave-studio/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  type ScopedProjectRef,
  type ThreadId,
} from "@specweave-studio/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import {
  composerDraftHasUserContent,
  markPromotedDraftThreadByRef,
  type DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { resolveProjectSettings } from "@specweave-studio/shared/projectSettings";
import { readProjects, readThreadShell, useProjects, useThreadShell } from "../state/entities";
import {
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
  resolveNewThreadModelSelectionOverride,
} from "../lib/chatThreadActions";
import { readStudioProjectFile } from "../lib/studioProjectFileDefaults";
import { environmentServerConfigsAtom } from "../state/server";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { legacyProjectCwdPreferenceKey, useUiStateStore } from "../uiStateStore";
import { followNewestModels } from "./followNewestModels";
import { useClientSettings, useLegacySidebarEnabled } from "./useSettings";

interface NewThreadWorkspaceOptions {
  branch?: string | null;
  worktreePath?: string | null;
  envMode?: DraftThreadEnvMode;
  startFromOrigin?: boolean;
  /** Explicit host picks must be stored before navigation mounts draft routing. */
  environmentSelection?: "auto" | "manual";
}

function pickExplicitEnvironmentSelection(options: NewThreadWorkspaceOptions | undefined) {
  return options?.environmentSelection !== undefined
    ? { environmentSelection: options.environmentSelection, loadBalancedEnvironmentId: null }
    : {};
}

// The workspace options the caller passed explicitly, shaped for the draft
// store: absent keys stay absent so they never overwrite existing draft
// state. Every reuse path applies exactly this set.
function pickExplicitWorkspaceOptions(options: NewThreadWorkspaceOptions | undefined) {
  return {
    ...(options?.branch !== undefined ? { branch: options.branch } : {}),
    ...(options?.worktreePath !== undefined ? { worktreePath: options.worktreePath } : {}),
    ...(options?.envMode !== undefined ? { envMode: options.envMode } : {}),
    ...(options?.startFromOrigin !== undefined ? { startFromOrigin: options.startFromOrigin } : {}),
    ...pickExplicitEnvironmentSelection(options),
  };
}

export function useNewThreadHandler() {
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const environmentServerConfigs = useAtomValue(environmentServerConfigsAtom);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const modelFollowLatest = useClientSettings((settings) => settings.modelFollowLatest);
  const providerModelPreferences = useClientSettings(
    (settings) => settings.providerModelPreferences,
  );
  const runFolderCheck = useProjectFolderCheckCommand();
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
        startFromOrigin?: boolean;
        environmentSelection?: "auto" | "manual";
        replace?: boolean;
      },
      // Which draft the thread ended up in, so a caller that has something to put in it — a
      // prepared checkout, a task to write — addresses that one rather than looking the project
      // up again and finding whichever draft it happens to hold.
    ): Promise<{ draftId: DraftId; threadId: ThreadId } | null> => {
      const projects = readProjects();
      const targetServerSettings =
        environmentServerConfigs.get(projectRef.environmentId)?.settings ?? DEFAULT_SERVER_SETTINGS;
      const targetProviders =
        environmentServerConfigs.get(projectRef.environmentId)?.providers ?? [];
      const {
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
        setModelSelection,
      } = useComposerDraftStore.getState();
      const requestingRouteHref = router.state.location.href;
      const routeChangedSinceRequest = () => router.state.location.href !== requestingRouteHref;
      const currentRouteTarget = getCurrentRouteTarget();
      // A new thread carries the user's working mode from the thread being
      // viewed. The target project's configured model still wins; interaction
      // mode carries independently. Permissions, branch, worktree, and env mode
      // come from configured defaults unless the caller passes them explicitly.
      const carrySourceShell =
        currentRouteTarget?.kind === "server"
          ? readThreadShell(currentRouteTarget.threadRef)
          : null;
      const carrySourceDraft =
        currentRouteTarget?.kind === "draft" ? getDraftSession(currentRouteTarget.draftId) : null;
      // Composer overrides win over the persisted thread state — they are
      // what the user currently sees in the composer controls.
      const carrySourceComposer = currentRouteTarget
        ? getComposerDraft(
            currentRouteTarget.kind === "server"
              ? currentRouteTarget.threadRef
              : currentRouteTarget.draftId,
          )
        : null;
      const composerActiveProvider = carrySourceComposer?.activeProvider ?? null;
      const composerModelSelection = composerActiveProvider
        ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
        : null;
      const carryModelSelection =
        composerModelSelection ?? carrySourceShell?.modelSelection ?? null;
      const carryInteractionMode =
        carrySourceComposer?.interactionMode ??
        carrySourceShell?.interactionMode ??
        carrySourceDraft?.interactionMode ??
        null;
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      if (
        !legacySidebarEnabled &&
        project &&
        !environmentServerConfigs.get(projectRef.environmentId)?.scratchWorkspaceRoot
      )
        return Promise.resolve(null);
      // Project work belongs to its retained coordinator. Independent chats start
      // in Scratch; existing drafts and the legacy workflow remain recoverable.
      if (
        !legacySidebarEnabled &&
        project &&
        !isScratchProject(
          project,
          environmentServerConfigs.get(projectRef.environmentId)?.scratchWorkspaceRoot,
        )
      ) {
        if (options?.branch || options?.worktreePath)
          enqueueProjectCoordinatorDraft({
            ...projectRef,
            text: projectWorkspaceIntentText({
              branch: options.branch,
              worktreePath: options.worktreePath,
            }),
          });
        return router
          .navigate({
            to: "/projects/$projectKey",
            params: {
              projectKey: deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
            },
            search: projectWorkspaceSearch(null, `${project.environmentId}:${project.id}`),
            replace: options?.replace ?? false,
          })
          .then(() => null);
      }
      // The resolver applies project overrides and, until the server has
      // folded them, the aggregate's own legacy fields.
      const projectSettings = resolveProjectSettings(
        targetServerSettings,
        project?.id ?? null,
        project,
      );
      const projectDefaultModelSelection = projectSettings.settings.defaultModelSelection;
      const defaultRuntimeMode = projectSettings.settings.defaultRuntimeMode;
      const resolveModelSelectionOverride = (destinationDraftId: DraftId) =>
        resolveNewThreadModelSelectionOverride({
          projectDefaultSelection: projectDefaultModelSelection ?? null,
          carrySelection: carryModelSelection,
          carrySourceDraftId:
            currentRouteTarget?.kind === "draft" ? currentRouteTarget.draftId : null,
          destinationDraftId,
        });
      // The shared resolver owns the priority order. The specweave-studio.json read is
      // skipped entirely when a higher-priority source decides, and its
      // query atom caches per project after the first call.
      const resolveDefaultEnvMode = async (): Promise<DraftThreadEnvMode> => {
        const consultProjectFile =
          project !== undefined && projectSettings.settings.defaultThreadEnvMode === null;
        const projectFile = consultProjectFile
          ? await readStudioProjectFile(project.environmentId, project.workspaceRoot)
          : null;
        return readNewThreadWorkspaceDefault({
          configuredMode:
            projectSettings.settings.defaultThreadEnvMode ??
            projectFile?.defaultThreadEnvMode ??
            null,
          environmentId: projectRef.environmentId,
          workspaceRoot: project?.workspaceRoot,
          ...(project !== undefined
            ? {
                readHoldsSeparateClones: () =>
                  readProjectFolderCheck(runFolderCheck, project).then((check) =>
                    check?.layout ? holdsSeparateClones(check.layout) : undefined,
                  ),
              }
            : {}),
        });
      };
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const hasStartFromOriginOption = options?.startFromOrigin !== undefined;
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedDraftThreadRef = storedDraftThread
        ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
        : null;
      const reusableStoredDraftThread =
        storedDraftThread !== null &&
        storedDraftThread.promotedTo == null &&
        storedDraftThreadRef !== null &&
        readThreadShell(storedDraftThreadRef) === null
          ? storedDraftThread
          : null;
      if (storedDraftThreadRef && reusableStoredDraftThread === null) {
        markPromotedDraftThreadByRef(storedDraftThreadRef);
      }
      // New-thread surfaces (button, hotkeys, "/" landing, palette) only
      // ever reuse a draft the user has NOT invested in. A draft with typed
      // text or attachments is work in progress: it stays alive where it is
      // (reachable from the sidebar draft rows) and this request mints a
      // fresh draft instead — the remap in the store preserves invested
      // drafts rather than deleting them.
      const emptyStoredDraftThread =
        reusableStoredDraftThread &&
        !composerDraftHasUserContent(getComposerDraft(reusableStoredDraftThread.draftId))
          ? reusableStoredDraftThread
          : null;
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (emptyStoredDraftThread) {
        return (async () => {
          const isDraftAlreadyOpen =
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === emptyStoredDraftThread.draftId;
          const hasExplicitWorkspaceOption =
            hasBranchOption ||
            hasWorktreePathOption ||
            hasEnvModeOption ||
            hasStartFromOriginOption;
          // Reused drafts keep their selected workspace. Defaults apply only
          // when minting a draft; an explicit invocation may still change it.
          let workspaceContext: NewThreadWorkspaceOptions | null = null;
          if (hasExplicitWorkspaceOption) {
            workspaceContext = pickExplicitWorkspaceOptions(options);
          } else if (!isDraftAlreadyOpen) {
            await Promise.resolve();
            if (routeChangedSinceRequest()) {
              return null;
            }
            // The await yields. If the draft was opened (a concurrent
            // invocation's navigation landed), promoted to a real thread,
            // remapped away (a concurrent invocation registered a fresh
            // draft — remapping back would evict the winner and let the
            // store GC it), or gained content (no longer a reusable empty
            // draft) in the meantime, this invocation is a stale loser:
            // resetting context, remapping, or navigating would all clobber
            // state written after the snapshot above. Bail out entirely —
            // the winner already did this work.
            const routeTargetNow = getCurrentRouteTarget();
            const openedMeanwhile =
              routeTargetNow?.kind === "draft" &&
              routeTargetNow.draftId === emptyStoredDraftThread.draftId;
            const currentMappedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
            const promotedMeanwhile =
              currentMappedDraft?.promotedTo != null ||
              (storedDraftThreadRef !== null && readThreadShell(storedDraftThreadRef) !== null);
            const remappedMeanwhile =
              currentMappedDraft?.draftId !== emptyStoredDraftThread.draftId;
            const movedMeanwhile =
              currentMappedDraft?.environmentId !== emptyStoredDraftThread.environmentId ||
              currentMappedDraft?.projectId !== emptyStoredDraftThread.projectId ||
              currentMappedDraft?.threadId !== emptyStoredDraftThread.threadId;
            const investedMeanwhile = composerDraftHasUserContent(
              getComposerDraft(emptyStoredDraftThread.draftId),
            );
            if (
              openedMeanwhile ||
              promotedMeanwhile ||
              remappedMeanwhile ||
              movedMeanwhile ||
              investedMeanwhile
            ) {
              return null;
            }
            // Omit inherited workspace fields. The store keeps its latest
            // same-project choices and clears branch/path on a project or
            // host change. Replaying this invocation's snapshot would undo
            // both a newer workspace pick and that host-specific clearing.
            workspaceContext = {};
          }
          if (workspaceContext) {
            setDraftThreadContext(emptyStoredDraftThread.draftId, {
              ...workspaceContext,
              ...pickExplicitEnvironmentSelection(options),
              ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            });
          }
          // Model intent: an explicit human pick always stands. Seeds and
          // legacy entries alike re-resolve here — sticky first, mirroring
          // the mint-fresh path, then the project default or carried
          // selection on top. This runs even when the draft is already open:
          // without it, a changed pin could never reach the draft the user
          // is looking at, because explicit picks are the only thing the
          // flag protects.
          const storedDraft = getComposerDraft(emptyStoredDraftThread.draftId);
          const storedDraftHasExplicitModelPick = hasExplicitComposerModelSelection(storedDraft);
          if (!storedDraftHasExplicitModelPick) {
            followNewestModels(targetProviders, modelFollowLatest, providerModelPreferences);
            applyStickyState(emptyStoredDraftThread.draftId);
            const modelSelectionOverride = resolveModelSelectionOverride(
              emptyStoredDraftThread.draftId,
            );
            if (modelSelectionOverride) {
              // This is a complete snapshot: absent options mean "no options",
              // not "keep the stale draft's options".
              setModelSelection(emptyStoredDraftThread.draftId, modelSelectionOverride, {
                replaceOptions: true,
              });
            }
          }
          // Only explicit workspace overrides ride along with the remap.
          // The store owns preservation and cross-project invalidation.
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            emptyStoredDraftThread.draftId,
            {
              threadId: emptyStoredDraftThread.threadId,
              ...workspaceContext,
              ...pickExplicitEnvironmentSelection(options),
              ...(!isDraftAlreadyOpen ? { runtimeMode: defaultRuntimeMode } : {}),
              ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
            },
          );
          const opened = {
            draftId: emptyStoredDraftThread.draftId,
            threadId: emptyStoredDraftThread.threadId,
          };
          // Re-read the route: the snapshot from before the await is stale
          // once a concurrent invocation's navigation lands, and navigating
          // again would push a duplicate history entry.
          const routeTargetAfterWrites = getCurrentRouteTarget();
          if (
            routeTargetAfterWrites?.kind === "draft" &&
            routeTargetAfterWrites.draftId === emptyStoredDraftThread.draftId
          ) {
            return opened;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: emptyStoredDraftThread.draftId },
            replace: options?.replace ?? false,
          });
          return opened;
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null &&
        // Same content rule as above: a new-thread request while viewing an
        // invested draft mints a fresh one instead of repurposing it.
        !composerDraftHasUserContent(getComposerDraft(currentRouteTarget.draftId))
      ) {
        if (
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasStartFromOriginOption
        ) {
          setDraftThreadContext(currentRouteTarget.draftId, pickExplicitWorkspaceOptions(options));
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...pickExplicitWorkspaceOptions(options),
        });
        return Promise.resolve({
          draftId: currentRouteTarget.draftId,
          threadId: latestActiveDraftThread.threadId,
        });
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        const initialEnvMode = options?.envMode ?? (await resolveDefaultEnvMode());
        if (routeChangedSinceRequest()) {
          return null;
        }
        // The await yields, so a concurrent invocation may have registered a
        // draft for this logical project in the meantime. Registering ours
        // too would evict that draft while its navigation is in flight —
        // reuse the winner instead, like the synchronous path above does.
        const racedDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
        if (
          racedDraft &&
          // Only a draft REGISTERED during the await counts as a raced
          // winner. An invested draft this invocation deliberately declined
          // to reuse is still mapped at this point — reusing it here would
          // silently undo mint-fresh semantics.
          racedDraft.draftId !== storedDraftThread?.draftId &&
          readThreadShell(scopeThreadRef(racedDraft.environmentId, racedDraft.threadId)) === null
        ) {
          // Same remap the reuse paths above perform: point the draft at the
          // caller's project member and apply explicit workspace options if
          // the caller passed any. Without explicit options the winner's
          // context stands untouched — the winner's navigation is landing,
          // which is the isDraftAlreadyOpen "leave it alone" case. Writing
          // this invocation's defaults here instead would clobber the
          // winner's explicit picks and could pair its worktreePath with a
          // contradictory envMode.
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, racedDraft.draftId, {
            threadId: racedDraft.threadId,
            createdAt: racedDraft.createdAt,
            runtimeMode: racedDraft.runtimeMode,
            interactionMode: racedDraft.interactionMode,
            ...pickExplicitWorkspaceOptions(options),
          });
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: racedDraft.draftId },
            replace: options?.replace ?? false,
          });
          return { draftId: racedDraft.draftId, threadId: racedDraft.threadId };
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: initialEnvMode,
          startFromOrigin:
            options?.startFromOrigin ??
            resolveNewDraftStartFromOrigin({
              envMode: initialEnvMode,
              newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
            }),
          runtimeMode: defaultRuntimeMode,
          ...pickExplicitEnvironmentSelection(options),
          ...(carryInteractionMode ? { interactionMode: carryInteractionMode } : {}),
        });
        followNewestModels(targetProviders, modelFollowLatest, providerModelPreferences);
        applyStickyState(draftId);
        const modelSelectionOverride = resolveModelSelectionOverride(draftId);
        if (modelSelectionOverride) {
          // Project defaults and carried selections both outrank global sticky
          // state. The project default wins when both are present.
          setModelSelection(draftId, modelSelectionOverride, { replaceOptions: true });
        }
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
          replace: options?.replace ?? false,
        });
        return { draftId, threadId };
      })();
    },
    [
      environmentServerConfigs,
      getCurrentRouteTarget,
      modelFollowLatest,
      providerModelPreferences,
      projectGroupingSettings,
      router,
      legacySidebarEnabled,
      runFolderCheck,
    ],
  );
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const routeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;
  const activeThread = useThreadShell(routeThreadRef);
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useProjects();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadHandler();

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeDraftId,
    routeThreadRef,
  };
}
