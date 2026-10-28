import {
  type DesktopPendingSnapShot,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ScopedThreadRef,
  type ScopedProjectRef,
  type EnvironmentId,
  ComposerDraftKey,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGES,
} from "@specweave-studio/contracts";
import { useCallback, useEffect, useRef } from "react";
import { useLocation, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useUnreachableHosts } from "../../studio/unreachableHosts";
import { parseProjectWorkspaceSearch } from "../../studio/projectPaneThreads";
import { getProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import { durableComposerDrafts } from "../../lib/durableComposerDraftBindings";
import { createIndexedDbDraftJournal } from "../../lib/durableComposerDraftJournal";
import {
  SNAP_SHOT_CONVERSATION_FOCUS_EVENT,
  isCoordinatorSnapShotTarget,
  resolveProjectSnapShotTarget,
  sameSnapShotTarget,
  snapShotReturnHref,
  type SnapShotTarget,
} from "./snapShotTarget";

import {
  type DraftId,
  type PersistedComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useClientSettings, useLegacySidebarEnabled } from "../../hooks/useSettings";
import { useScratchProject } from "../../hooks/useScratchProject";
import { readProjects, readThreadShell } from "../../state/entities";
import { compressImageToByteLimit, dataUrlToFile } from "../../lib/imageCompression";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import {
  beginSnapShotAnimation,
  dismissAllSnapShotAnimations,
  dismissSnapShotAnimation,
  finishSnapShotAnimation,
  getPendingSnapShotAnimations,
  updateSnapShotAnimationSource,
  waitForSnapShotAnimationDestination,
} from "../../lib/snapShotAnimation";
import { resizeSnapShotSource } from "../../lib/snapShotSource";
import { playSnapShotSound } from "../../lib/snapShotSound";
import {
  dispatchSnapShotComposerFocus,
  getDesktopSnapShotBridge,
  type DesktopSnapShotBridge,
} from "../../lib/desktopSnapShot";
import { readFileAsDataUrl } from "../ChatView.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";

type CaptureTarget = SnapShotTarget;

export function resolveExistingSnapShotTarget(
  target: CaptureTarget,
  routeThreadRef: ScopedThreadRef | null,
): CaptureTarget | null {
  const store = useComposerDraftStore.getState();
  if (isCoordinatorSnapShotTarget(target)) {
    return readProjects().some(
      (p) =>
        p.environmentId === target.projectRef.environmentId && p.id === target.projectRef.projectId,
    )
      ? target
      : null;
  }
  if (typeof target === "string") {
    const draftSession = store.getDraftSession(target);
    if (draftSession?.promotedTo) return draftSession.promotedTo;
    return draftSession ? target : null;
  }
  const targetIsCurrentRoute =
    routeThreadRef !== null &&
    routeThreadRef.environmentId === target.environmentId &&
    routeThreadRef.threadId === target.threadId;
  return targetIsCurrentRoute ||
    store.getDraftSessionByRef(target) !== null ||
    readThreadShell(target) !== null
    ? target
    : null;
}

const NEXT_PAINT_FALLBACK_MS = 100;

export async function beginSnapShotAnimationWhenReady(
  id: string,
  target: Promise<CaptureTarget | null>,
  pendingStarts: Set<string>,
): Promise<void> {
  pendingStarts.add(id);
  try {
    const resolvedTarget = await target;
    if (
      pendingStarts.delete(id) &&
      resolvedTarget &&
      !isCoordinatorSnapShotTarget(resolvedTarget)
    ) {
      beginSnapShotAnimation(id, resolvedTarget);
    }
  } finally {
    pendingStarts.delete(id);
  }
}

export function dismissFailedSnapShot(
  id: string | undefined,
  soundedIds: Set<string>,
  pendingStarts: Set<string>,
): void {
  if (id) {
    pendingStarts.delete(id);
    soundedIds.delete(id);
    void dismissSnapShotAnimation(id);
  } else {
    pendingStarts.clear();
    soundedIds.clear();
    dismissAllSnapShotAnimations();
  }
}

export function resolveSnapShotTargetOnce(
  resolutionRef: { current: Promise<CaptureTarget | null> | null },
  resolveTarget: () => Promise<CaptureTarget | null>,
): Promise<CaptureTarget | null> {
  if (resolutionRef.current) return resolutionRef.current;
  const resolution = resolveTarget().finally(() => {
    if (resolutionRef.current === resolution) resolutionRef.current = null;
  });
  resolutionRef.current = resolution;
  return resolution;
}

// A capture keeps its destination even after its animation unmounts or the window blurs.
export function resolveSnapShotDeliveryTarget(
  targets: Map<string, Promise<CaptureTarget | null>>,
  id: string,
  resolveTarget: () => Promise<CaptureTarget | null>,
): Promise<CaptureTarget | null> {
  const existing = targets.get(id);
  if (existing) return existing;
  const target = resolveTarget().catch(() => null);
  targets.set(id, target);
  void target.then((resolved) => {
    if (!resolved && targets.get(id) === target) targets.delete(id);
  });
  return target;
}

async function afterNextPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    const fallback = window.setTimeout(resolve, NEXT_PAINT_FALLBACK_MS);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.clearTimeout(fallback);
        resolve();
      });
    });
  });
}

export async function deliverSnapShot(
  bridge: DesktopSnapShotBridge,
  item: DesktopPendingSnapShot,
  target: CaptureTarget,
  focus = true,
): Promise<void> {
  const store = useComposerDraftStore.getState();
  updateSnapShotAnimationSource(item.id, item.source);
  const capture = await bridge.readSnapShot(item.id);
  const original = dataUrlToFile(capture.dataUrl, capture.name, capture.mimeType);
  const compressed = await compressImageToByteLimit(original, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  if (!compressed.ok) {
    finishSnapShotAnimation(item.id);
    throw new Error("The captured window is too large to attach.");
  }
  const file = compressed.file;
  const source = resizeSnapShotSource(capture.source, compressed.imageSize);
  const dataUrl = compressed.recompressed ? await readFileAsDataUrl(file) : capture.dataUrl;
  if (isCoordinatorSnapShotTarget(target)) {
    const { environmentId, projectId } = target.projectRef;
    const composer = getProjectCoordinatorComposer(environmentId, projectId);
    const attachments = composer.getSnapshot().attachments;
    if (!attachments.some(({ id }) => id === capture.id)) {
      if (
        attachments.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
        attachments.filter((item) => item.type === "image").length >= PROVIDER_SEND_TURN_MAX_IMAGES
      )
        throw new Error("Remove an attachment, then try this capture again.");
      composer.setAttachments([
        ...attachments,
        {
          type: "image",
          id: capture.id,
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl: dataUrl,
          file,
          source,
        },
      ]);
    }
    const draft = composer.getSnapshot();
    const key = ComposerDraftKey.make(`coordinator:${projectId}`);
    durableComposerDrafts.schedule(
      { environmentId, key },
      {
        prompt: draft.prompt,
        attachments: draft.attachments.flatMap((item) =>
          item.file
            ? [
                {
                  id: item.id,
                  type: item.type,
                  name: item.name,
                  mimeType: item.mimeType,
                  sizeBytes: item.sizeBytes,
                  file: item.file,
                  ...(item.type === "image" && item.source ? { source: item.source } : {}),
                },
              ]
            : [],
        ),
      },
    );
    await durableComposerDrafts.journalSettled();
    const saved = await createIndexedDbDraftJournal()?.read(key);
    if (
      saved?.environmentId !== environmentId ||
      !saved.snapshot.attachments.some(
        (item) =>
          item.id === capture.id &&
          item.sizeBytes === file.size &&
          JSON.stringify(item.source) === JSON.stringify(source),
      )
    )
      throw new Error("The captured window could not be saved to the project draft.");
    finishSnapShotAnimation(capture.id);
    await bridge.acknowledgeSnapShot(capture.id);
    return;
  }
  const alreadyAttached =
    store.getComposerDraft(target)?.images.some(({ id }) => id === capture.id) ?? false;
  if (
    !alreadyAttached &&
    !store.addImage(target, {
      type: "image",
      id: capture.id,
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl: dataUrl,
      file,
      source,
    })
  ) {
    throw new Error("Remove an attachment, then try this capture again.");
  }
  const persisted: PersistedComposerImageAttachment = {
    id: capture.id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    dataUrl,
    source,
  };
  const persistedAttachments =
    store
      .getComposerDraft(target)
      ?.persistedAttachments.filter((attachment) => attachment.id !== capture.id) ?? [];
  await store.syncPersistedAttachments(target, [...persistedAttachments, persisted]);
  if (!store.getComposerDraft(target)?.persistedAttachments.some(({ id }) => id === capture.id)) {
    throw new Error("The captured window could not be saved to the draft.");
  }

  // Reveal the attachment under the flying capture before the desktop tears the overlay down,
  // otherwise the tile is missing for the frames between the landing and its first paint.
  if (getPendingSnapShotAnimations().some((animation) => animation.id === capture.id)) {
    await afterNextPaint();
    await waitForSnapShotAnimationDestination(capture.id).catch(() => undefined);
    finishSnapShotAnimation(capture.id);
    await afterNextPaint();
  }
  await bridge.acknowledgeSnapShot(capture.id);
  if (focus) dispatchSnapShotComposerFocus();
}

/** A global capture without an existing chat starts an independent chat on the chosen machine. */
export async function resolveNewSnapShotTarget(input: {
  readonly legacy: boolean;
  readonly projectRef: ScopedProjectRef | null;
  readonly scratchEnvironmentId: (preferred: EnvironmentId | null) => EnvironmentId | null;
  readonly startScratchThread: (
    environmentId: EnvironmentId,
  ) => Promise<{ readonly draftId: DraftId } | null>;
  readonly openThread: (
    projectRef: ScopedProjectRef,
  ) => Promise<{ readonly draftId: DraftId } | null>;
}): Promise<DraftId | null> {
  if (input.legacy)
    return input.projectRef ? ((await input.openThread(input.projectRef))?.draftId ?? null) : null;
  const environmentId = input.scratchEnvironmentId(input.projectRef?.environmentId ?? null);
  return environmentId ? ((await input.startScratchThread(environmentId))?.draftId ?? null) : null;
}

export function SnapShotCoordinator() {
  const legacy = useLegacySidebarEnabled();
  const { scratchEnvironmentId, startScratchThread } = useScratchProject();
  const {
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeDraftId,
    routeThreadRef: legacyRouteThreadRef,
  } = useHandleNewThread();
  const location = useLocation();
  const router = useRouter();
  const { projectKey } = useParams({ strict: false });
  const search = useSearch({
    strict: false,
    select: (value) => parseProjectWorkspaceSearch(value as Record<string, unknown>),
  });
  const groups = useSettingsProjectGroups();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const unreachable = useUnreachableHosts();
  const lastViewed = useClientSettings((settings) => settings.projectCoordinatorMachines);
  const projectTarget = projectKey
    ? resolveProjectSnapShotTarget({
        group: groups.find((group) => group.projectKey === projectKey),
        search,
        lastViewed: lastViewed[projectKey],
        primaryEnvironmentId,
        unreachable,
      })
    : null;
  const coordinatorTarget = projectKey
    ? resolveProjectSnapShotTarget({
        group: groups.find((group) => group.projectKey === projectKey),
        search: search.checkout ? { checkout: search.checkout } : {},
        lastViewed: lastViewed[projectKey],
        primaryEnvironmentId,
        unreachable,
      })
    : null;
  const routeThreadRef =
    legacyRouteThreadRef ??
    (projectTarget &&
    typeof projectTarget !== "string" &&
    !isCoordinatorSnapShotTarget(projectTarget)
      ? projectTarget
      : null);
  const captureSound = useClientSettings((settings) =>
    settings.snapShotPlaySound ? settings.snapShotSound : null,
  );
  const animateCaptures = useClientSettings((settings) => settings.snapShotAnimations);
  const captureTargetsRef = useRef(new Map<string, Promise<CaptureTarget | null>>());
  const lastTargetRef = useRef<CaptureTarget | null>(null);
  const lastTargetHrefRef = useRef<string | null>(null);
  const captureLocationsRef = useRef(
    new Map<string, { requestedHref: string; returnHref: string | null }>(),
  );
  const locationRef = useRef(location);
  locationRef.current = location;
  const targetResolutionRef = useRef<Promise<CaptureTarget | null> | null>(null);
  const drainingRef = useRef<Promise<void> | null>(null);
  const rerunRequestedRef = useRef(false);
  const soundedCaptureIdsRef = useRef(new Set<string>());
  const pendingAnimationStartsRef = useRef(new Set<string>());

  // Window-local and scoped to the conversation route. Settings keeps the last
  // destination, while another project, checkout or thread invalidates pane focus.
  const conversationKey = JSON.stringify([
    projectKey,
    coordinatorTarget,
    routeThreadRef,
    routeDraftId,
  ]);
  const focusedTargetRef = useRef<{ key: string; target: CaptureTarget } | null>(null);
  if (projectKey && focusedTargetRef.current?.key !== conversationKey) {
    focusedTargetRef.current = null;
  }
  const focusedTarget =
    focusedTargetRef.current?.key === conversationKey ? focusedTargetRef.current.target : null;
  const currentTarget = focusedTarget ?? routeThreadRef ?? routeDraftId ?? projectTarget;
  const currentTargetRef = useRef<CaptureTarget | null>(currentTarget);
  currentTargetRef.current = currentTarget;
  if (projectKey && !currentTarget) {
    lastTargetRef.current = null;
    lastTargetHrefRef.current = null;
  }
  if (currentTarget) {
    lastTargetRef.current = currentTarget;
    lastTargetHrefRef.current = location.href;
  }

  useEffect(() => {
    if (!projectKey) return;
    const rememberPane = (event: Event) => {
      const element = event.target as Element | null;
      const pane = element?.closest?.("[data-project-pane]")?.getAttribute("data-project-pane");
      const target =
        pane === "coordinator" ? coordinatorTarget : pane === "threads" ? routeThreadRef : null;
      if (!target) return;
      focusedTargetRef.current = { key: conversationKey, target };
      currentTargetRef.current = target;
      lastTargetRef.current = target;
      lastTargetHrefRef.current = location.href;
    };
    // Pointer selection and keyboard input express conversation intent. Background
    // renders and programmatic autofocus must not select the other pane.
    let tabNavigation = false;
    let tabReset: ReturnType<typeof setTimeout> | undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      rememberPane(event);
      tabNavigation = event.key === "Tab" || event.key === "F6";
      clearTimeout(tabReset);
      // Browser Tab focus changes occur after keydown, before the next task.
      tabReset = setTimeout(() => {
        tabNavigation = false;
      }, 0);
    };
    const onFocus = (event: FocusEvent) => {
      if (tabNavigation) rememberPane(event);
      tabNavigation = false;
    };
    document.addEventListener(SNAP_SHOT_CONVERSATION_FOCUS_EVENT, rememberPane, true);
    document.addEventListener("pointerdown", rememberPane, true);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocus, true);
    return () => {
      document.removeEventListener(SNAP_SHOT_CONVERSATION_FOCUS_EVENT, rememberPane, true);
      document.removeEventListener("pointerdown", rememberPane, true);
      clearTimeout(tabReset);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocus, true);
    };
  }, [conversationKey, projectKey, coordinatorTarget, routeThreadRef, location.href]);

  const resolveTarget = useCallback(async (): Promise<CaptureTarget | null> => {
    if (projectKey && !currentTarget) return null;
    const lastTarget = lastTargetRef.current;
    if (lastTarget) {
      const existingTarget = resolveExistingSnapShotTarget(lastTarget, routeThreadRef);
      if (existingTarget) {
        lastTargetRef.current = existingTarget;
        return existingTarget;
      }
      lastTargetRef.current = null;
    }
    const projectRef = resolveThreadActionProjectRef({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
    const target = await resolveNewSnapShotTarget({
      legacy,
      projectRef,
      scratchEnvironmentId,
      startScratchThread,
      openThread: handleNewThread,
    });
    if (target) lastTargetRef.current = target;
    return target;
  }, [
    activeDraftThread,
    activeThread,
    defaultProjectRef,
    handleNewThread,
    routeThreadRef,
    projectKey,
    currentTarget,
    legacy,
    scratchEnvironmentId,
    startScratchThread,
  ]);

  const resolveCaptureTarget = useCallback(
    () => resolveSnapShotTargetOnce(targetResolutionRef, resolveTarget),
    [resolveTarget],
  );

  const playCaptureSound = useCallback(
    (id: string) => {
      if (!captureSound || soundedCaptureIdsRef.current.has(id)) return;
      soundedCaptureIdsRef.current.add(id);
      try {
        playSnapShotSound(captureSound);
      } catch {}
    },
    [captureSound],
  );

  const drain = useCallback(async () => {
    const bridge = getDesktopSnapShotBridge();
    if (!bridge) return;
    if (drainingRef.current) {
      rerunRequestedRef.current = true;
      return drainingRef.current;
    }

    const operation = (async () => {
      do {
        rerunRequestedRef.current = false;
        const pending = await bridge.listPendingSnapShots();
        for (const item of pending) {
          playCaptureSound(item.id);
          const capturedTarget = await resolveSnapShotDeliveryTarget(
            captureTargetsRef.current,
            item.id,
            resolveCaptureTarget,
          );
          const target = capturedTarget
            ? resolveExistingSnapShotTarget(capturedTarget, routeThreadRef)
            : null;
          if (!target) {
            await dismissSnapShotAnimation(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Snapshot taken, but no project is available",
                description: "Add a project, then capture the window again.",
              }),
            );
            continue;
          }

          try {
            const captureLocation = captureLocationsRef.current.get(item.id);
            await deliverSnapShot(bridge, item, target, false);
            const href = captureLocation
              ? snapShotReturnHref(
                  captureLocation.requestedHref,
                  router.state.location.href,
                  captureLocation.returnHref,
                )
              : null;
            if (href) await router.navigate({ href });
            await afterNextPaint();
            if (
              sameSnapShotTarget(currentTargetRef.current, target) &&
              !isCoordinatorSnapShotTarget(target)
            )
              dispatchSnapShotComposerFocus();
            captureLocationsRef.current.delete(item.id);
            captureTargetsRef.current.delete(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
          } catch (error) {
            await dismissSnapShotAnimation(item.id);
            soundedCaptureIdsRef.current.delete(item.id);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Snapshot failed",
                description: `Capture ${item.id}: ${
                  error instanceof Error ? error.message : "Try the capture again."
                }`,
              }),
            );
          }
        }
      } while (rerunRequestedRef.current);
    })()
      .catch((error: unknown) => {
        dismissAllSnapShotAnimations();
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Snapshot failed",
            description: error instanceof Error ? error.message : "Try the capture again.",
          }),
        );
      })
      .finally(() => {
        drainingRef.current = null;
      });
    drainingRef.current = operation;
    return operation;
  }, [playCaptureSound, resolveCaptureTarget, routeThreadRef, router]);

  useEffect(() => {
    const bridge = getDesktopSnapShotBridge();
    if (!bridge) return;
    void drain();
    const unsubscribe = bridge.onSnapShotEvent((event) => {
      switch (event.type) {
        case "requested": {
          captureLocationsRef.current.set(event.id, {
            requestedHref: locationRef.current.href,
            returnHref: lastTargetHrefRef.current,
          });
          const current = lastTargetRef.current;
          const target = current ? resolveExistingSnapShotTarget(current, routeThreadRef) : null;
          // Creating a new draft would navigate the renderer before a self-capture finishes.
          // Pin existing drafts now; create a destination after acquisition when none exists.
          if (target) {
            void resolveSnapShotDeliveryTarget(captureTargetsRef.current, event.id, () =>
              Promise.resolve(target),
            );
          }
          return;
        }
        case "started": {
          playCaptureSound(event.id);
          if (animateCaptures && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            void beginSnapShotAnimationWhenReady(
              event.id,
              resolveSnapShotDeliveryTarget(
                captureTargetsRef.current,
                event.id,
                resolveCaptureTarget,
              ),
              pendingAnimationStartsRef.current,
            );
          }
          return;
        }
        case "ready":
          void drain();
          return;
        case "failed": {
          if (event.id) {
            captureTargetsRef.current.delete(event.id);
            captureLocationsRef.current.delete(event.id);
          }
          dismissFailedSnapShot(
            event.id,
            soundedCaptureIdsRef.current,
            pendingAnimationStartsRef.current,
          );
          void bridge.getSnapShotState().then((state) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Snapshot failed",
                description: state.message ?? "Try the capture again.",
              }),
            );
          });
          return;
        }
        case "shortcut-changed":
          return;
      }
    });
    return unsubscribe;
  }, [animateCaptures, drain, playCaptureSound, resolveCaptureTarget, routeThreadRef]);

  useEffect(() => {
    const dismissOnBlur = () => {
      pendingAnimationStartsRef.current.clear();
      dismissAllSnapShotAnimations();
    };
    const drainOnFocus = () => void drain();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") dismissOnBlur();
      else void drain();
    };
    window.addEventListener("blur", dismissOnBlur);
    window.addEventListener("focus", drainOnFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("blur", dismissOnBlur);
      window.removeEventListener("focus", drainOnFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [drain]);

  return null;
}
