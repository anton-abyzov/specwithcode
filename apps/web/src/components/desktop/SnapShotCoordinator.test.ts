import { scopeProjectRef, scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  type DesktopPendingSnapShot,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { getProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
import type { DesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import {
  SnapShotCoordinator,
  beginSnapShotAnimationWhenReady,
  deliverSnapShot,
  dismissFailedSnapShot,
  resolveExistingSnapShotTarget,
  resolveNewSnapShotTarget,
  resolveSnapShotTargetOnce,
  resolveSnapShotDeliveryTarget,
} from "./SnapShotCoordinator";
import {
  beginSnapShotAnimation,
  dismissAllSnapShotAnimations,
  getPendingSnapShotAnimations,
  setSnapShotAnimationDestination,
  scheduleSnapShotAnimationDestination,
} from "../../lib/snapShotAnimation";

const routing = vi.hoisted(() => {
  const runtime = {
    projectKey: null as string | null,
    search: {} as Record<string, unknown>,
    location: { href: "/", pathname: "/" },
    groups: [] as unknown[],
    projects: [] as unknown[],
    knownThread: false,
    scratch: vi.fn(async () => null),
    openThread: vi.fn(async () => null),
    journal: undefined as unknown,
    journalFails: false,
    journalDropsSource: false,
    listeners: new Set<(event: { type: string; id: string }) => void>(),
  };
  const navigate = vi.fn(async ({ href }: { href: string }) => {
    runtime.location = { href, pathname: href.split("?")[0]! };
  });
  return Object.assign(runtime, {
    router: {
      state: {
        get location() {
          return runtime.location;
        },
      },
      navigate,
    },
  });
});
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => routing.location,
  useParams: () => ({ projectKey: routing.projectKey }),
  useSearch: () => routing.search,
  useRouter: () => routing.router,
  useNavigate: () => routing.router.navigate,
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useHandleNewThread: () => ({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: null,
    handleNewThread: routing.openThread,
    routeDraftId: null,
    routeThreadRef: null,
  }),
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => "snap-shot-environment",
    startScratchThread: routing.scratch,
  }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useLegacySidebarEnabled: () => false,
  useClientSettings: (select: (s: unknown) => unknown) =>
    select({
      projectCoordinatorMachines: {},
      snapShotPlaySound: false,
      snapShotAnimations: false,
    }),
}));
vi.mock("../settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => routing.groups,
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "snap-shot-environment",
}));
vi.mock("../../studio/unreachableHosts", () => ({ useUnreachableHosts: () => new Set() }));
vi.mock("../../state/entities", async (original) => ({
  ...(await original<typeof import("../../state/entities")>()),
  readThreadShell: () => (routing.knownThread ? { id: "worker" } : null),
  readProjects: () => routing.projects,
}));
vi.mock("../../lib/durableComposerDraftBindings", () => ({
  durableComposerDrafts: {
    schedule: (target: unknown, snapshot: unknown) => {
      routing.journal = { ...(target as object), snapshot };
    },
    journalSettled: async () => undefined,
  },
}));
vi.mock("../../lib/durableComposerDraftJournal", () => ({
  createIndexedDbDraftJournal: () => ({
    read: async () => {
      if (routing.journalFails) return undefined;
      if (!routing.journalDropsSource) return routing.journal;
      const saved = routing.journal as { snapshot: { attachments: Array<{ source?: unknown }> } };
      return {
        ...saved,
        snapshot: {
          ...saved.snapshot,
          attachments: saved.snapshot.attachments.map(
            ({ source: _source, ...attachment }) => attachment,
          ),
        },
      };
    },
  }),
}));

const storage = vi.hoisted(() => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
});

const environmentId = EnvironmentId.make("snap-shot-environment");
const projectRef = scopeProjectRef(environmentId, ProjectId.make("snap-shot-project"));

beforeEach(() => {
  routing.projectKey = null;
  routing.search = {};
  routing.location = { href: "/", pathname: "/" };
  routing.groups = [];
  routing.projects = [];
  routing.knownThread = false;
  routing.journal = undefined;
  routing.journalFails = false;
  routing.journalDropsSource = false;
  routing.listeners.clear();
  routing.scratch.mockClear();
  routing.openThread.mockClear();
  routing.router.navigate.mockClear();
  storage.clear();
  vi.stubGlobal("localStorage", storage);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
});

afterEach(() => {
  dismissAllSnapShotAnimations();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("window capture failures", () => {
  it("dismisses an older failed capture without disturbing a newer capture", async () => {
    const target = DraftId.make("snap-shot-draft");
    const pendingStarts = new Set<string>();
    const soundedIds = new Set(["older", "newer"]);
    const dismissSnapShotAnimation = vi.fn(async () => undefined);
    vi.stubGlobal("window", {
      localStorage: storage,
      desktopBridge: {
        requestSnapShotPermissions: vi.fn(),
        getSnapShotState: vi.fn(),
        checkSnapShotShortcut: vi.fn(),
        setSnapShotShortcutSuppressed: vi.fn(),
        listPendingSnapShots: vi.fn(),
        readSnapShot: vi.fn(),
        acknowledgeSnapShot: vi.fn(),
        onSnapShotEvent: vi.fn(() => () => undefined),
        dismissSnapShotAnimation,
      },
    });
    await beginSnapShotAnimationWhenReady("older", Promise.resolve(target), pendingStarts);
    await beginSnapShotAnimationWhenReady("newer", Promise.resolve(target), pendingStarts);

    dismissFailedSnapShot("older", soundedIds, pendingStarts);

    expect(getPendingSnapShotAnimations().map(({ id }) => id)).toEqual(["newer"]);
    expect(soundedIds).toEqual(new Set(["newer"]));
    expect(dismissSnapShotAnimation).toHaveBeenCalledExactlyOnceWith("older");
  });

  it("does not resurrect a failed capture when its draft becomes ready later", async () => {
    const target = DraftId.make("snap-shot-draft");
    let resolveTarget: ((target: DraftId) => void) | undefined;
    const targetReady = new Promise<DraftId>((resolve) => {
      resolveTarget = resolve;
    });
    const pendingStarts = new Set<string>();
    const soundedIds = new Set(["older", "newer"]);
    const olderStart = beginSnapShotAnimationWhenReady("older", targetReady, pendingStarts);
    await beginSnapShotAnimationWhenReady("newer", Promise.resolve(target), pendingStarts);

    dismissFailedSnapShot("older", soundedIds, pendingStarts);
    resolveTarget?.(target);
    await olderStart;

    expect(getPendingSnapShotAnimations().map(({ id }) => id)).toEqual(["newer"]);
    expect(soundedIds).toEqual(new Set(["newer"]));
    expect(pendingStarts.size).toBe(0);
  });

  it("keeps global failures dismissing all active and pending captures", async () => {
    const target = DraftId.make("snap-shot-draft");
    let resolveTarget: ((target: DraftId) => void) | undefined;
    const targetReady = new Promise<DraftId>((resolve) => {
      resolveTarget = resolve;
    });
    const pendingStarts = new Set<string>();
    const soundedIds = new Set(["older", "newer"]);
    await beginSnapShotAnimationWhenReady("older", Promise.resolve(target), pendingStarts);
    const newerStart = beginSnapShotAnimationWhenReady("newer", targetReady, pendingStarts);

    dismissFailedSnapShot(undefined, soundedIds, pendingStarts);
    resolveTarget?.(target);
    await newerStart;

    expect(getPendingSnapShotAnimations()).toEqual([]);
    expect(soundedIds.size).toBe(0);
    expect(pendingStarts.size).toBe(0);
  });
});

describe("window capture delivery", () => {
  it.each([
    { target: DraftId.make("snap-shot-draft"), accessibleText: undefined },
    { target: DraftId.make("snap-shot-draft"), accessibleText: "const answer = 42;" },
    {
      target: scopeThreadRef(environmentId, ThreadId.make("snap-shot-thread")),
      accessibleText: undefined,
    },
    {
      target: scopeThreadRef(environmentId, ThreadId.make("snap-shot-thread")),
      accessibleText: "const answer = 42;",
    },
  ])(
    "preserves capture contents for $target before a stalled animation finishes ($accessibleText)",
    async ({ target, accessibleText }) => {
      vi.useFakeTimers();
      const never = new Promise<void>(() => undefined);
      const animationFrames: Array<FrameRequestCallback> = [];
      const acknowledgeSnapShot = vi.fn(async () => undefined);
      const bridge = {
        requestSnapShotPermissions: vi.fn(async () => undefined),
        getSnapShotState: vi.fn(),
        checkSnapShotShortcut: vi.fn(),
        setSnapShotShortcutSuppressed: vi.fn(async () => undefined),
        listPendingSnapShots: vi.fn(async () => []),
        readSnapShot: vi.fn(async () => ({
          id: "12345678-1234-1234-1234-123456789abc",
          name: "window.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataUrl: "data:image/png;base64,AQID",
          source: {
            kind: "snap-shot" as const,
            capturedAt: "2026-09-01T00:00:00.000Z",
            appName: "Editor",
            windowTitle: "main.ts",
            ...(accessibleText ? { accessibleText } : {}),
          },
        })),
        acknowledgeSnapShot,
        setSnapShotAnimationDestination: vi.fn(() => never),
        onMenuAction: vi.fn(() => () => undefined),
        onSnapShotEvent: vi.fn(() => () => undefined),
      } as unknown as DesktopSnapShotBridge;
      const item: DesktopPendingSnapShot = {
        id: "12345678-1234-1234-1234-123456789abc",
        name: "window.png",
        mimeType: "image/png",
        sizeBytes: 3,
        source: {
          kind: "snap-shot",
          capturedAt: "2026-09-01T00:00:00.000Z",
          appName: "Editor",
          windowTitle: "main.ts",
          ...(accessibleText ? { accessibleText } : {}),
        },
      };
      vi.stubGlobal("window", {
        localStorage: storage,
        desktopBridge: bridge,
        setTimeout,
        clearTimeout,
        matchMedia: () => ({ matches: false }),
        getComputedStyle: () => ({
          backgroundColor: "rgb(0, 0, 0)",
          borderTopColor: "rgb(255, 255, 255)",
          borderTopLeftRadius: "8px",
          borderTopWidth: "1px",
        }),
        dispatchEvent: vi.fn(),
      });
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        animationFrames.push(callback);
        return animationFrames.length;
      });

      if (typeof target === "string") {
        useComposerDraftStore.getState().setProjectDraftThreadId(projectRef, target, {
          threadId: ThreadId.make("snap-shot-draft-thread"),
        });
      }
      beginSnapShotAnimation(item.id, target);
      setSnapShotAnimationDestination(
        item.id,
        {
          isConnected: true,
          getBoundingClientRect: () => ({ x: 0, y: 0, width: 208, height: 112 }),
        } as HTMLElement,
        item.source,
      );

      const delivery = deliverSnapShot(bridge, item, target);
      await vi.advanceTimersByTimeAsync(0);

      const draft = useComposerDraftStore.getState().getComposerDraft(target);
      expect(draft?.images).toHaveLength(1);
      expect(draft?.images[0]?.source).toEqual(item.source);
      expect(getPendingSnapShotAnimations()).toHaveLength(1);
      expect(acknowledgeSnapShot).not.toHaveBeenCalled();

      expect(animationFrames).toHaveLength(1);
      animationFrames.shift()?.(0);
      animationFrames.shift()?.(0);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(getPendingSnapShotAnimations()).toHaveLength(0);
      expect(acknowledgeSnapShot).not.toHaveBeenCalled();
      expect(animationFrames).toHaveLength(1);
      animationFrames.shift()?.(0);
      expect(acknowledgeSnapShot).not.toHaveBeenCalled();
      animationFrames.shift()?.(0);
      await delivery;
      expect(acknowledgeSnapShot).toHaveBeenCalledWith(item.id);
    },
  );
});

describe("window capture target resolution", () => {
  it("shares bare-route draft creation between animation start and capture drain", async () => {
    const draftId = DraftId.make("snap-shot-draft");
    let finishResolution: ((target: DraftId) => void) | undefined;
    const resolveTarget = vi.fn(
      () =>
        new Promise<DraftId>((resolve) => {
          finishResolution = resolve;
        }),
    );
    const resolutionRef: { current: Promise<DraftId | null> | null } = { current: null };

    const animationTarget = resolveSnapShotTargetOnce(resolutionRef, resolveTarget);
    const attachmentTarget = resolveSnapShotTargetOnce(resolutionRef, resolveTarget);

    expect(animationTarget).toBe(attachmentTarget);
    expect(resolveTarget).toHaveBeenCalledTimes(1);
    finishResolution?.(draftId);
    await expect(animationTarget).resolves.toBe(draftId);
    expect(resolutionRef.current).toBeNull();
  });

  it("follows a draft to its promoted server thread", () => {
    const draftId = DraftId.make("snap-shot-draft");
    const promotedRef = scopeThreadRef(environmentId, ThreadId.make("snap-shot-promoted-thread"));
    const store = useComposerDraftStore.getState();
    store.setProjectDraftThreadId(projectRef, draftId, {
      threadId: ThreadId.make("snap-shot-draft-thread"),
    });
    store.markDraftThreadPromoting(draftId, promotedRef);

    expect(resolveExistingSnapShotTarget(draftId, null)).toEqual(promotedRef);
  });

  it("keeps the routed server thread before its shell loads", () => {
    const routeThreadRef = scopeThreadRef(environmentId, ThreadId.make("snap-shot-routed-thread"));

    expect(resolveExistingSnapShotTarget(routeThreadRef, routeThreadRef)).toEqual(routeThreadRef);
  });
});

describe("durable snapshot delivery", () => {
  it.each([false, true])(
    "retains a capture on quota failure and retries without duplicates (staged: %s)",
    async (staged) => {
      const target = scopeThreadRef(environmentId, ThreadId.make("quota-thread"));
      const capture = {
        id: "12345678-1234-1234-1234-123456789abc",
        name: "window.png",
        mimeType: "image/png" as const,
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,AQID",
        source: {
          kind: "snap-shot" as const,
          capturedAt: "2026-09-01T00:00:00.000Z",
          appName: "Editor",
          windowTitle: "main.ts",
        },
      };
      const acknowledgeSnapShot = vi.fn(async () => undefined);
      const bridge = {
        readSnapShot: async () => capture,
        acknowledgeSnapShot,
      } as unknown as DesktopSnapShotBridge;
      vi.stubGlobal("window", { localStorage: storage, dispatchEvent: vi.fn() });
      const write = storage.setItem.getMockImplementation()!;
      storage.setItem.mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      try {
        if (staged) {
          const store = useComposerDraftStore.getState();
          store.addImage(target, {
            type: "image",
            ...capture,
            previewUrl: capture.dataUrl,
            file: new File([new Uint8Array([1, 2, 3])], capture.name, { type: capture.mimeType }),
          });
          void store.syncPersistedAttachments(target, [capture]);
        }
        await expect(deliverSnapShot(bridge, capture, target)).rejects.toThrow(
          "could not be saved",
        );
        expect(acknowledgeSnapShot).not.toHaveBeenCalled();
        expect(
          useComposerDraftStore.getState().getComposerDraft(target)?.nonPersistedImageIds,
        ).toContain(capture.id);
        storage.setItem.mockImplementation(write);
        await deliverSnapShot(bridge, capture, target);
        expect(acknowledgeSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id);
        expect(useComposerDraftStore.getState().getComposerDraft(target)?.images).toHaveLength(1);
        expect(
          useComposerDraftStore.getState().getComposerDraft(target)?.persistedAttachments,
        ).toHaveLength(1);
      } finally {
        storage.setItem.mockImplementation(write);
      }
    },
  );
});

describe("snapshot destination ownership", () => {
  it.each(["unmount", "blur", "disabled animations"])(
    "keeps the original environment and thread after %s",
    async (reason) => {
      const original = scopeThreadRef(environmentId, ThreadId.make("original"));
      const next = scopeThreadRef(EnvironmentId.make("another-environment"), ThreadId.make("next"));
      const targets = new Map<string, Promise<typeof original | null>>();
      let current = original;
      const resolveTarget = async () => current;
      const requested = resolveSnapShotDeliveryTarget(targets, "capture", resolveTarget);
      if (reason !== "disabled animations") {
        beginSnapShotAnimation("capture", original);
        if (reason === "unmount") {
          const unmount = scheduleSnapShotAnimationDestination("capture", () => undefined);
          unmount();
        } else dismissAllSnapShotAnimations();
      }
      current = next;
      await requested;
      expect(getPendingSnapShotAnimations()).toHaveLength(0);
      expect(await resolveSnapShotDeliveryTarget(targets, "capture", resolveTarget)).toEqual(
        original,
      );
      expect(await resolveSnapShotDeliveryTarget(targets, "later-capture", resolveTarget)).toEqual(
        next,
      );
    },
  );
});

it.each([projectRef, null])(
  "global capture opens Scratch without creating a project worker (%s)",
  async (projectRef) => {
    const draftId = DraftId.make("capture-scratch");
    const startScratchThread = vi.fn(async () => ({ draftId }));
    const openThread = vi.fn();
    const target = await resolveNewSnapShotTarget({
      legacy: false,
      projectRef,
      scratchEnvironmentId: () => environmentId,
      startScratchThread,
      openThread,
    });
    expect(target).toBe(draftId);
    expect(startScratchThread).toHaveBeenCalledWith(environmentId);
    expect(openThread).not.toHaveBeenCalled();
  },
);

const routedCapture = {
  id: "12345678-1234-1234-1234-123456789abc",
  name: "window.png",
  mimeType: "image/png" as const,
  sizeBytes: 3,
  dataUrl: "data:image/png;base64,AQID",
  source: {
    kind: "snap-shot" as const,
    capturedAt: "2026-10-27T00:42:15.142Z",
    appName: "SpecWithCode",
    windowTitle: "Settings",
    accessibleText: "Snapshot settings",
    accessibility: {
      format: "element-tree" as const,
      coordinateSpace: "captured-image" as const,
      imageSize: { width: 4096, height: 2420 },
      truncated: false,
      root: {
        role: "button",
        name: "Done",
        bounds: { x: 2456, y: 1500, width: 118, height: 64 },
        children: [],
      },
    },
  },
};

it.each([
  { navigateElsewhere: false, pane: null },
  { navigateElsewhere: true, pane: null },
  { navigateElsewhere: false, pane: "coordinator" },
  { navigateElsewhere: false, pane: "threads" },
  { navigateElsewhere: false, pane: "coordinator", keyboard: "Tab" },
  { navigateElsewhere: false, pane: "coordinator", keyboard: "F6" },
  { navigateElsewhere: false, pane: "coordinator", command: true },
  { navigateElsewhere: true, pane: "coordinator" },
])(
  "delivers focused $pane capture through Settings without creating Scratch (new navigation: $navigateElsewhere)",
  async ({ navigateElsewhere, pane, keyboard, command = false }) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const win = Object.assign(new EventTarget(), {
      localStorage: storage,
      setTimeout,
      clearTimeout,
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
      setTimeout(() => fn(0), 0),
    );
    const target = scopeThreadRef(environmentId, ThreadId.make("worker"));
    useComposerDraftStore.getState().setPrompt(target, "Keep every user word");
    const coordinator = getProjectCoordinatorComposer(environmentId, projectRef.projectId);
    coordinator.setPrompt("Keep coordinator words");
    coordinator.setAttachments([]);
    routing.knownThread = true;
    routing.projectKey = "repo";
    routing.search = {
      thread: target.threadId,
      checkout: `${environmentId}:${projectRef.projectId}`,
    };
    const member = { environmentId, id: projectRef.projectId, workspaceSettings: {} };
    routing.groups = [{ projectKey: "repo", memberProjects: [member] }];
    routing.projects = [member];
    const priorHref = `/projects/repo?thread=worker&checkout=${environmentId}:${projectRef.projectId}`;
    routing.location = { href: priorHref, pathname: "/projects/repo" };
    let pending: DesktopPendingSnapShot[] = [];
    const acknowledgeSnapShot = vi.fn(async () => undefined);
    Object.assign(win, {
      desktopBridge: {
        requestSnapShotPermissions: vi.fn(),
        getSnapShotState: vi.fn(),
        checkSnapShotShortcut: vi.fn(),
        setSnapShotShortcutSuppressed: vi.fn(),
        listPendingSnapShots: async () => pending,
        readSnapShot: async () => routedCapture,
        acknowledgeSnapShot,
        onSnapShotEvent: (fn: (e: { type: string; id: string }) => void) => {
          routing.listeners.add(fn);
          return () => routing.listeners.delete(fn);
        },
      },
    });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(createElement(SnapShotCoordinator));
      });
      if (pane) {
        const event = new Event(command ? "snap-shot-conversation-focus" : "pointerdown");
        Object.defineProperty(event, "target", {
          value: {
            closest: () => ({ getAttribute: () => pane }),
          },
        });
        if (keyboard) {
          const tab = new Event("keydown");
          Object.defineProperty(tab, "key", { value: keyboard });
          document.dispatchEvent(tab);
          const focus = new Event("focusin");
          Object.defineProperty(focus, "target", { value: event.target });
          document.dispatchEvent(focus);
        } else document.dispatchEvent(event);
        // A background render must not restore the URL's open side thread.
        await act(() => renderer!.update(createElement(SnapShotCoordinator)));
      }
      // Open Settings before the keypress, as in the user's report.
      routing.projectKey = null;
      routing.search = {};
      routing.location = { href: "/settings/snap-shot", pathname: "/settings/snap-shot" };
      await act(() => {
        renderer!.update(createElement(SnapShotCoordinator));
      });
      for (const fn of routing.listeners) fn({ type: "requested", id: routedCapture.id });
      if (navigateElsewhere) {
        routing.projectKey = "another";
        routing.location = { href: "/projects/another", pathname: "/projects/another" };
        await act(() => {
          renderer!.update(createElement(SnapShotCoordinator));
        });
      }
      pending = [routedCapture];
      await act(async () => {
        for (const fn of routing.listeners) fn({ type: "ready", id: routedCapture.id });
        await vi.waitFor(() => expect(acknowledgeSnapShot).toHaveBeenCalledWith(routedCapture.id));
        await new Promise((resolve) => setTimeout(resolve, 25));
      });
      expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
        "Keep every user word",
      );
      expect(
        useComposerDraftStore
          .getState()
          .getComposerDraft(target)
          ?.images.map((i) => i.id),
      ).toEqual(pane === "coordinator" ? [] : [routedCapture.id]);
      expect(coordinator.getSnapshot().prompt).toBe("Keep coordinator words");
      expect(coordinator.getSnapshot().attachments.map((a) => a.id)).toEqual(
        pane === "coordinator" ? [routedCapture.id] : [],
      );
      expect(routing.scratch).not.toHaveBeenCalled();
      expect(routing.openThread).not.toHaveBeenCalled();
      if (navigateElsewhere) expect(routing.router.navigate).not.toHaveBeenCalled();
      else expect(routing.router.navigate).toHaveBeenCalledWith({ href: priorHref });
    } finally {
      await act(() => renderer?.unmount());
    }
  },
);

it.each([false, true])(
  "keeps coordinator text and acknowledges only a durably saved project attachment (journal fails: %s)",
  async (fails) => {
    const target = { kind: "coordinator" as const, projectRef };
    const composer = getProjectCoordinatorComposer(environmentId, projectRef.projectId);
    composer.setPrompt("Preserve coordinator words");
    composer.setAttachments([]);
    routing.journalFails = fails;
    const acknowledgeSnapShot = vi.fn(async () => undefined);
    const bridge = {
      readSnapShot: async () => routedCapture,
      acknowledgeSnapShot,
    } as unknown as DesktopSnapShotBridge;
    if (fails)
      await expect(deliverSnapShot(bridge, routedCapture, target)).rejects.toThrow(
        "could not be saved to the project draft",
      );
    else await deliverSnapShot(bridge, routedCapture, target);
    expect(composer.getSnapshot().prompt).toBe("Preserve coordinator words");
    expect(composer.getSnapshot().attachments.map((a) => a.id)).toEqual([routedCapture.id]);
    expect(
      (routing.journal as { snapshot: { attachments: Array<{ source?: unknown }> } }).snapshot
        .attachments[0]?.source,
    ).toEqual(routedCapture.source);
    expect(acknowledgeSnapShot).toHaveBeenCalledTimes(fails ? 0 : 1);
    routing.journalFails = false;
    await deliverSnapShot(bridge, routedCapture, target);
    expect(composer.getSnapshot().attachments).toHaveLength(1);
  },
);

it("does not acknowledge a journal that retained pixels but lost the captured context", async () => {
  const target = { kind: "coordinator" as const, projectRef };
  const composer = getProjectCoordinatorComposer(environmentId, projectRef.projectId);
  composer.setPrompt("Preserve user words");
  composer.setAttachments([]);
  routing.journalDropsSource = true;
  const acknowledgeSnapShot = vi.fn(async () => undefined);
  const bridge = {
    readSnapShot: async () => routedCapture,
    acknowledgeSnapShot,
  } as unknown as DesktopSnapShotBridge;
  await expect(deliverSnapShot(bridge, routedCapture, target)).rejects.toThrow(
    "could not be saved to the project draft",
  );
  expect(acknowledgeSnapShot).not.toHaveBeenCalled();
  expect(composer.getSnapshot().prompt).toBe("Preserve user words");
});
