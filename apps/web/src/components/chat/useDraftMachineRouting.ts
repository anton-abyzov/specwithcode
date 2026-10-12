import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@specweave-studio/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useComposerDraftStore, type DraftId, type DraftSessionState } from "~/composerDraftStore";
import type { useLoadBalancedEnvironment } from "~/hooks/useLoadBalancedEnvironment";
import type { useScratchProject } from "~/hooks/useScratchProject";
import {
  deriveLogicalProjectKeyFromSettings,
  type ProjectGroupingSettings,
} from "~/logicalProject";
import type { useProjects } from "~/state/entities";
import type { EnvironmentPresentation } from "~/state/environments";
import { readEnvironmentScope } from "~/state/session";
import type { EnvironmentOption } from "../BranchToolbar.logic";
import { toastManager } from "../ui/toast";
import {
  draftHasMachineBoundContent,
  draftMachineUnavailableReason,
  MACHINE_ATTACHMENT_BLOCK_REASON,
  selectDraftMachineTarget,
} from "./draftMachineSelection";

interface Input {
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly envLocked: boolean;
  readonly sendInFlightRef: Readonly<{ current: boolean }>;
  readonly environments: readonly EnvironmentPresentation[];
  readonly allProjects: ReturnType<typeof useProjects>;
  readonly logicalProjectEnvironments: readonly EnvironmentOption[];
  readonly projectGroupingSettings: ProjectGroupingSettings;
  readonly activeProjectIsScratch: boolean;
  readonly activeProjectKey: string | null;
  readonly needsLoadBalancing: boolean;
  readonly loadBalancing: ReturnType<typeof useLoadBalancedEnvironment>;
  readonly openScratchProject: ReturnType<typeof useScratchProject>["openScratchProject"];
}

/** All machine-routing entry points share current draft, send and destination checks. */
export function useDraftMachineRouting(input: Input) {
  const {
    draftId,
    draftThread,
    envLocked,
    sendInFlightRef,
    logicalProjectEnvironments,
    activeProjectIsScratch,
    activeProjectKey,
    needsLoadBalancing,
    loadBalancing,
    openScratchProject,
  } = input;
  const { getDraftSession, setDraftThreadContext, setLogicalProjectDraftThreadId } =
    useComposerDraftStore.getState();
  const draftMachinePendingRef = useRef(false);
  const environmentChangeRef = useRef<{ readonly environmentId: EnvironmentId } | null>(null);
  const draftMachineContextRef = useRef(input);
  draftMachineContextRef.current = input;
  useEffect(() => {
    if (
      !needsLoadBalancing ||
      loadBalancing.pending ||
      !draftId ||
      draftMachineContextRef.current.draftId !== draftId ||
      draftMachineContextRef.current.envLocked ||
      draftMachineContextRef.current.sendInFlightRef.current ||
      draftMachinePendingRef.current ||
      environmentChangeRef.current
    )
      return;
    const currentDraft = getDraftSession(draftId);
    if (!currentDraft || currentDraft !== draftThread || currentDraft.promotedTo) return;
    const target = logicalProjectEnvironments.find(
      (environment) => environment.environmentId === loadBalancing.environmentId,
    );
    if (
      !target?.projectId ||
      (target.environmentId !== currentDraft.environmentId &&
        draftHasMachineBoundContent(useComposerDraftStore.getState().getComposerDraft(draftId)))
    )
      return;
    const environment = draftMachineContextRef.current.environments.find(
      (item) => item.environmentId === target.environmentId,
    );
    if (
      !environment ||
      draftMachineUnavailableReason(
        environment.connection.phase,
        readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope),
      ) ||
      !draftMachineContextRef.current.allProjects.some(
        (project) =>
          project.environmentId === target.environmentId && project.id === target.projectId,
      )
    )
      return;
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(target.environmentId, target.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsLoadBalancing,
    loadBalancing.pending,
    loadBalancing.environmentId,
    draftId,
    draftThread,
    getDraftSession,
    sendInFlightRef,
    logicalProjectEnvironments,
    setDraftThreadContext,
  ]);
  const onAutoEnvironment = useCallback(() => {
    if (
      envLocked ||
      !draftId ||
      draftMachineContextRef.current.draftId !== draftId ||
      draftMachineContextRef.current.envLocked ||
      draftMachineContextRef.current.sendInFlightRef.current ||
      draftMachinePendingRef.current ||
      environmentChangeRef.current
    )
      return;
    const currentDraft = getDraftSession(draftId);
    if (!currentDraft || currentDraft !== draftThread || currentDraft.promotedTo) return;
    if (draftHasMachineBoundContent(useComposerDraftStore.getState().getComposerDraft(draftId))) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments on this machine",
        description: MACHINE_ATTACHMENT_BLOCK_REASON,
      });
      return;
    }
    const candidates = draftMachineContextRef.current.logicalProjectEnvironments.flatMap(
      (target) => {
        const environment = draftMachineContextRef.current.environments.find(
          (item) => item.environmentId === target.environmentId,
        );
        return environment &&
          !draftMachineUnavailableReason(
            environment.connection.phase,
            readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope),
          )
          ? [target.environmentId]
          : [];
      },
    );
    if (!candidates.length) return;
    loadBalancing.refresh(candidates);
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
      branch: null,
      worktreePath: null,
    });
  }, [
    envLocked,
    draftId,
    draftThread,
    sendInFlightRef,
    getDraftSession,
    setDraftThreadContext,
    loadBalancing.refresh,
    logicalProjectEnvironments,
  ]);
  // The machine an in-flight switch is heading to; a newer switch replaces it.
  const [isEnvironmentChanging, setIsEnvironmentChanging] = useState(false);
  const onDraftMachinePendingChange = useCallback((pending: boolean) => {
    if (pending) environmentChangeRef.current = null;
    draftMachinePendingRef.current = pending;
    setIsEnvironmentChanging(pending);
  }, []);
  useLayoutEffect(() => {
    return () => {
      environmentChangeRef.current = null;
      setIsEnvironmentChanging(false);
    };
  }, [draftId, activeProjectKey]);

  const onEnvironmentChange = useCallback(
    (nextEnvironmentId: EnvironmentId) => {
      if (
        !draftId ||
        draftMachineContextRef.current.draftId !== draftId ||
        draftMachineContextRef.current.envLocked ||
        draftMachineContextRef.current.sendInFlightRef.current ||
        draftMachinePendingRef.current ||
        getDraftSession(draftId) !== draftThread
      )
        return;
      const target = draftMachineContextRef.current.logicalProjectEnvironments.find(
        (env) => env.environmentId === nextEnvironmentId,
      );
      if (!target) return;
      const request = { environmentId: target.environmentId };
      environmentChangeRef.current = request;
      setIsEnvironmentChanging(true);
      void selectDraftMachineTarget({
        target,
        readDraft: () => getDraftSession(draftId),
        readComposer: () => useComposerDraftStore.getState().getComposerDraft(draftId),
        isBlocked: () =>
          draftMachineContextRef.current.envLocked ||
          draftMachineContextRef.current.sendInFlightRef.current ||
          draftMachinePendingRef.current,
        isCurrentRequest: () =>
          environmentChangeRef.current === request &&
          draftMachineContextRef.current.draftId === draftId,
        unavailableReason: () => {
          const latest = draftMachineContextRef.current;
          const environment = latest.environments.find(
            (item) => item.environmentId === target.environmentId,
          );
          if (!environment) return "This machine is no longer saved. Connect it again.";
          const reason = draftMachineUnavailableReason(
            environment.connection.phase,
            readEnvironmentScope(target.environmentId, AuthOrchestrationOperateScope),
          );
          if (reason) return reason;
          return !latest.logicalProjectEnvironments.some(
            (item) =>
              item.environmentId === target.environmentId &&
              (target.projectId === null || item.projectId === target.projectId),
          )
            ? "The destination project is no longer available. Choose it again."
            : null;
        },
        resolveProject: async () => {
          const project =
            target.projectId === null
              ? await openScratchProject(target.environmentId, "Could not switch machine")
              : draftMachineContextRef.current.allProjects.find(
                  (item) =>
                    item.environmentId === target.environmentId && item.id === target.projectId,
                );
          return project ? { ...project, projectId: project.id } : null;
        },
        commit: (project) => {
          const projectRef = scopeProjectRef(project.environmentId, project.id);
          const draftOptions = {
            environmentSelection: "manual" as const,
            loadBalancedEnvironmentId: null,
            // No project is a plain server-owned folder, even before Git status arrives.
            ...(activeProjectIsScratch || target.projectId === null
              ? {
                  envMode: "local" as const,
                  startFromOrigin: false,
                  branch: null,
                  worktreePath: null,
                }
              : {}),
          };
          if (activeProjectIsScratch) {
            // Scratch projects are machine-local, so move their logical mapping too.
            setLogicalProjectDraftThreadId(
              deriveLogicalProjectKeyFromSettings(
                project,
                draftMachineContextRef.current.projectGroupingSettings,
              ),
              projectRef,
              draftId,
              draftOptions,
            );
          } else {
            setDraftThreadContext(draftId, {
              projectRef,
              ...draftOptions,
            });
          }
        },
      })
        .then((result) => {
          if (environmentChangeRef.current === request && result.status === "blocked")
            toastManager.add({
              type: "warning",
              title: "Could not switch machine",
              description: result.reason,
            });
        })
        .catch(() => {
          if (environmentChangeRef.current === request)
            toastManager.add({
              type: "warning",
              title: "Could not switch machine",
              description: "Your draft is unchanged. Choose the machine again.",
            });
        })
        .finally(() => {
          if (environmentChangeRef.current === request) {
            environmentChangeRef.current = null;
            setIsEnvironmentChanging(false);
          }
        });
    },
    [
      activeProjectIsScratch,
      draftId,
      draftThread,
      getDraftSession,
      openScratchProject,
      sendInFlightRef,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  return {
    draftMachinePendingRef,
    environmentChangeRef,
    isEnvironmentChanging,
    onDraftMachinePendingChange,
    onAutoEnvironment,
    onEnvironmentChange,
  };
}
