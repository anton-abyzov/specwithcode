import * as DateTime from "effect/DateTime";
// @vitest-environment jsdom
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
vi.mock("../../state/queries", () => ({
  useTurnItemDetail: () => ({ data: undefined, isPending: false, error: null }),
}));

// Keep exported fixture mock signatures portable in composite TypeScript declarations.
type FixtureProcedure = (...args: any[]) => any;
const state = vi.hoisted(() => ({
  send: vi.fn<FixtureProcedure>(),
  /** Renders of the Markdown stand-in whose props changed. */
  markdownRenders: 0,
  nativeContinue: vi.fn(async (_kind: string, _selection: unknown) => {}),
  nativeError: null as string | null,
  openLink: vi.fn(async () => undefined),
  openMenu: vi.fn(async () => undefined),
  refresh: vi.fn<FixtureProcedure>(),
  settle: vi.fn<FixtureProcedure>(),
  navigate: vi.fn<FixtureProcedure>(),
  /** The thread the stand-in chat's "Open related thread" button opens. */
  relatedThreadId: "worker",
  /** The routing value the stand-in chat last saw. */
  routing: null as import("../../studio/projectMessageRouting").ProjectMessageRouting | null,
  canOperate: true,
  /** What a worker's saved-report query returns. */
  threadReports: null as Record<string, unknown> | null,
  /** null: the same answer as canOperate. */
  canWriteSourceControl: null as boolean | null,
  connected: true,
  projectLoaded: true,
  shellsBootstrapped: true,
  primaryRegistered: true,
  messages: [] as Array<{
    id: string;
    text: string;
    role: string;
    createdBy: string;
    creationSource?: string;
    senderThreadId?: string;
    delegatedCompletion?: { taskIds: string[] };
    runId?: string | null;
    createdAt?: unknown;
    updatedAt?: unknown;
    streaming: boolean;
    attachments: import("@specweave-studio/contracts").ChatAttachment[];
  }>,
  attachments: [] as import("@specweave-studio/contracts").ChatAttachment[],
  /** The coordinator thread's runs and turn items, which its live progress line reads. */
  runs: [] as Array<{
    id: string;
    ordinal: number;
    status: string;
    requestedAt: string;
    providerInstanceId?: string;
    modelSelection?: { instanceId: string; model: string };
  }>,
  turnItems: [] as Array<{
    runId: string;
    ordinal: number;
    type: string;
    status: string;
    toolName?: string;
  }>,
  /** The coordinator's runtime requests; a pending user_input one with its card asks a question. */
  runtimeRequests: [] as unknown[],
  detailStatus: "live",
  shellRefresh: vi.fn(),
  coordinatorId: "coord" as string | null,
  coordinatorModel: { instanceId: "claude-native", model: "coordinator-model" } as {
    instanceId: string;
    model: string;
  } | null,
  /** Exercise the real workspace-to-picker assembly in model-display regressions. */
  realCoordinatorModelPicker: false,
  shells: [] as EnvironmentThreadShell[],
  /** The source control status every thread card reads. */
  git: null as Record<string, unknown> | null,
  pullRequestRequests: [] as unknown[],
  /** What the card's own deadline finds: still pending (true) or already acted on. */
  expireResult: false,
  detailsPanelsShown: [] as unknown[],
  goal: "",
  starters: null as {
    suggestions: import("@specweave-studio/contracts").ProjectStarterSuggestion[];
    hasWorkspace: boolean;
  } | null,
  startersPending: false,
  /** The workspace read has not answered yet. */
  projectReadPending: false,
  startersError: null as string | null,
  starterReads: 0,
  providers: [] as unknown[],
  /** The host's server settings; absent until a test needs them. */
  hostSettings: undefined as unknown,
  /** The host has not sent its configuration (and so its providers) yet. */
  serverConfigPending: false,
  phone: false,
  /** Touch is the primary pointer (a phone or tablet), not a mouse or trackpad. */
  coarse: false,
  sendShortcut: "enter",
  /** The client's timeline detail, which sets how soon worker messages fold. */
  timelineDetail: "normal" as "concise" | "normal" | "verbose",
  uploadsSupported: true,
  /** The host takes files with a question's answer. */
  questionAttachments: true,
  uploadFails: false,
  uploadsStarted: [] as string[],
  uploadsReleased: [] as string[],
  uploads: {} as Record<string, unknown>,
  uploadGate: null as Promise<void> | null,
  maxFileBytes: (50 * 1024 * 1024) as number | null,
  /** Stands in for HEIC conversion and shrinking, which jsdom cannot decode. */
  prepareImage: vi.fn<FixtureProcedure>(),
  /** Other machines' checkouts of the project. */
  otherCheckouts: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
  recoveryHosts: [] as string[],
  /** Other machines whose servers this device cannot reach. */
  offlineHosts: [] as string[],
  /** Other machines this device is paired with; each is connected unless offline. */
  pairedHosts: [] as string[],
  /** Paired machines that are connected but have not sent their projects since. */
  syncingHosts: [] as string[],
  /** What the project page's folder check reports, unless the real check runs. */
  folderHealth: "unknown" as "unknown" | "ok" | "missing" | "file",
  /** Runs the real folder check, answered by `send`, in place of `folderHealth`. */
  realFolderHealth: false,
  /** The project read's kind; unset leaves it out, as an older server does. */
  projectKind: undefined as "code" | "personal" | undefined,
  savedMachines: {} as Record<string, string>,
  project: {
    id: "project",
    environmentId: "host",
    title: "Atlas",
    workspaceRoot: "/scratch/atlas",
    defaultModelSelection: { instanceId: "codex-native", model: "worker-model" },
  },
}));
vi.mock("../../studio/useThreadCardGitStatus", () => ({
  useThreadCardGitStatus: () => state.git,
}));
vi.mock("../../studio/threadPullRequestRequests", () => ({
  PULL_REQUEST_REQUEST_TTL_MS: 15_000,
  PULL_REQUEST_REQUEST_EXPIRED_REASON: "Nothing answered.",
  requestThreadPullRequest: (ref: unknown) => {
    state.pullRequestRequests.push(ref);
    return 1;
  },
  expireThreadPullRequest: () => state.expireResult,
  showThreadDetailsPanel: (ref: unknown) => state.detailsPanelsShown.push(ref),
}));
vi.mock("./ProjectIconEditor", () => ({
  ProjectIconButton: () => null,
}));
vi.mock("../settings/useSettingsProjectGroups", () => ({
  useSettingsProjectGroups: () => [
    { projectKey: "atlas", memberProjects: [state.project, ...state.otherCheckouts] },
  ],
}));
const noArchivedSnapshots = vi.hoisted(() => Object.freeze([]));
vi.mock("../../lib/archivedThreadsState", () => ({
  // One list, as the atom answers: a fresh one per read would look like a new archive.
  useArchivedThreadSnapshots: () => ({ snapshots: noArchivedSnapshots, error: null }),
}));
vi.mock("../../state/entities", () => ({
  useAllEnvironmentShellsBootstrapped: () => state.shellsBootstrapped,
  useEnvironmentShellLive: (environmentId: string | null) =>
    environmentId !== null && !state.syncingHosts.includes(environmentId),
  useProjects: () => (state.projectLoaded ? [state.project, ...state.otherCheckouts] : []),
  useThreadShells: () => state.shells,
  // Like the atoms behind them: a list keeps its identity while nothing it holds changed.
  useThreadShellsForProjectRefs: (
    refs: ReadonlyArray<{ environmentId: string; projectId: string }>,
  ) =>
    keptList(
      `shells:${refs.map((ref) => `${ref.environmentId}:${ref.projectId}`).join("|")}`,
      state.shells.filter((shell) =>
        refs.some(
          (ref) => ref.environmentId === shell.environmentId && ref.projectId === shell.projectId,
        ),
      ),
      (kept, next) => kept === next,
    ),
  useThreadLinkTargets: (environmentId: string) =>
    keptList(
      `links:${environmentId}`,
      state.shells
        .filter((shell) => shell.environmentId === environmentId)
        .map(({ id, projectId, title, deletedAt }) => ({
          environmentId,
          id,
          projectId,
          title,
          deletedAt,
        })),
      (kept, next) =>
        kept.id === next.id &&
        kept.projectId === next.projectId &&
        kept.title === next.title &&
        kept.deletedAt === next.deletedAt,
    ),
  readThreadShells: () => state.shells,
  useThreadProjection: () => {
    const selection = state.shells.find(
      (shell) => shell.id === state.coordinatorId,
    )?.modelSelection;
    return {
      projection: {
        messages: state.messages,
        runs: state.runs.map((run) => ({
          ...run,
          modelSelection: run.modelSelection ?? selection,
          providerInstanceId: run.providerInstanceId ?? selection?.instanceId,
        })),
        turnItems: state.turnItems,
        thread: { id: state.coordinatorId },
        updatedAt: DateTime.makeUnsafe("2026-10-28T12:00:00Z"),
        runtimeRequests: state.runtimeRequests,
      },
    };
  },
  useThreadShell: (ref: { threadId: string } | null) =>
    ref === null ? null : (state.shells.find((shell) => shell.id === ref.threadId) ?? null),
  useThreadHistory: () => ({ hasMoreHistory: false }),
  useThreadStatus: () => state.detailStatus,
  // The More menu reads each machine's scratch folder to leave Design off "No project".
  useServerConfigs: () => new Map(),
}));
const noUnreachableEnvironments = vi.hoisted(() => new Set<string>());
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    environments: [
      ...state.recoveryHosts.map((environmentId) => ({
        environmentId,
        label: environmentId,
        connection: { phase: "connected" },
      })),
      ...state.pairedHosts.map((environmentId) => ({
        environmentId,
        label: environmentId,
        connection: {
          phase: state.offlineHosts.includes(environmentId) ? "disconnected" : "connected",
        },
      })),
      {
        environmentId: "host",
        label: "Test host",
        connection: { phase: state.connected ? "connected" : "disconnected" },
      },
    ],
  }),
  usePrimaryEnvironmentId: () => (state.primaryRegistered ? "primary" : null),
  useUnreachableEnvironmentIds: () => noUnreachableEnvironments,
  useEnvironment: (environmentId: string) => ({
    label: environmentId === "host" || environmentId === undefined ? "Test host" : environmentId,
    connection: {
      phase:
        state.connected && !state.offlineHosts.includes(environmentId)
          ? "connected"
          : "disconnected",
    },
    serverConfig: state.serverConfigPending
      ? undefined
      : {
          providers: state.providers,
          ...(state.hostSettings === undefined ? {} : { settings: state.hostSettings }),
          environment: {
            capabilities: {
              attachmentUploads: state.uploadsSupported,
              questionAttachments: state.questionAttachments,
              ...(state.maxFileBytes === null
                ? {}
                : { fileAttachments: { maxUploadBytes: state.maxFileBytes } }),
            },
          },
        },
  }),
}));
const keptLists = vi.hoisted(() => new Map<string, readonly unknown[]>());
function keptList<T>(key: string, next: readonly T[], same: (kept: T, next: T) => boolean) {
  const kept = keptLists.get(key) as readonly T[] | undefined;
  if (kept && kept.length === next.length && kept.every((row, index) => same(row, next[index]!)))
    return kept;
  keptLists.set(key, next);
  return next;
}
const uploadListeners = vi.hoisted(() => new Set<() => void>());
/** Upload progress changed in `state.uploads`: what the real queue's store announces. */
function notifyUploads() {
  for (const listener of uploadListeners) listener();
}
function subscribeUploads(listener: () => void) {
  uploadListeners.add(listener);
  return () => {
    uploadListeners.delete(listener);
  };
}
vi.mock("../../lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: (select: (store: { uploadsByImageId: object }) => unknown) =>
    select({ uploadsByImageId: useSyncExternalStore(subscribeUploads, () => state.uploads) }),
  // Like the queue: nothing starts without the right to send, and a second start is a no-op.
  startAttachmentUpload: ({ image }: { image: { id: string } }) => {
    if (!state.canOperate || state.uploadsStarted.includes(image.id)) return;
    state.uploadsStarted.push(image.id);
  },
  awaitAttachmentUploads: async () => {
    await state.uploadGate;
  },
  getUploadedAttachments: ({
    images,
  }: {
    images: Array<{ type: string; id: string; name: string; mimeType: string; sizeBytes: number }>;
  }) =>
    state.uploadFails || images.some((image) => !state.uploadsStarted.includes(image.id))
      ? null
      : images.map((image, index) => ({
          type: image.type,
          id: `pending-${index}`,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
        })),
  releaseDraftAttachment: (image: { id: string }) => {
    state.uploadsReleased.push(image.id);
  },
}));
vi.mock("../../lib/imageCompression", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/imageCompression")>()),
  prepareImageForAttachment: (file: File, maxBytes: number) => state.prepareImage(file, maxBytes),
}));
vi.mock("../chat/ExpandedImageDialog", () => ({
  ExpandedImageDialog: ({
    preview,
    onClose,
  }: {
    preview: { images: Array<{ name: string; src: string | null }>; index: number };
    onClose: () => void;
  }) => (
    <div data-lightbox data-index={preview.index}>
      {preview.images.map((image) => image.name).join(",")}
      <button type="button" onClick={onClose}>
        Close preview
      </button>
    </div>
  ),
}));
vi.mock("../files/AttachmentFilePreview", () => ({
  AttachmentFilePreview: (props: { name: string; file?: Blob | null }) => (
    <div data-file-preview={props.name}>{props.file ? "local bytes" : "no bytes"}</div>
  ),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => state.canOperate,
  useEnvironmentsWithScope: () => new Set(state.canOperate ? ["host", ...state.recoveryHosts] : []),
  useEnvironmentScope: (_environmentId: string, scope: string) =>
    scope === "source-control:write"
      ? (state.canWriteSourceControl ?? state.canOperate)
      : state.canOperate,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { starters?: true; reports?: true } | null) => {
    if (query === null)
      return { data: null, isPending: false, error: null, refresh: vi.fn<FixtureProcedure>() };
    if (query.reports) {
      return { data: state.threadReports, isPending: false, error: null, refresh: state.refresh };
    }
    if (query.starters) {
      state.starterReads += 1;
      return {
        data: state.starters,
        isPending: state.startersPending,
        error: state.startersError,
        refresh: vi.fn<FixtureProcedure>(),
      };
    }
    return projectRead();
  },
}));
const projectRead = vi.hoisted(() => () => ({
  data: state.projectReadPending
    ? undefined
    : {
        settings: {
          revision: 1,
          goal: state.goal,
          instructions: "",
          coordinatorThreadId: state.coordinatorId,
          coordinatorModelSelection: state.coordinatorModel,
          paused: false,
          archived: false,
          autoResume: true,
          ...(state.projectKind ? { kind: state.projectKind } : {}),
        },
        memory: { files: [], totalBytes: 0 },
      },
  isPending: state.projectReadPending,
  refresh: state.refresh,
}));
// The design list is its own query; without this the catch-all above would answer it with a project read.
vi.mock("../design/useProjectDesigns", () => ({
  useProjectDesigns: () => ({
    designs: [],
    problems: [],
    count: 0,
    byThreadId: new Map(),
    refresh: vi.fn<FixtureProcedure>(),
    loaded: true,
    error: null,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.send }));
vi.mock("../../state/assets", () => ({ assetEnvironment: { createUrl: {} } }));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({ _tag: "Failure" }),
}));
vi.mock("../../state/threads", () => ({
  threadEnvironment: { loadEarlierHistory: {}, updateMetadata: {}, startTurn: {} },
}));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    settleThread: state.settle,
    unsettleThread: state.settle,
    unarchiveThread: state.settle,
  }),
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    read: () => ({}),
    send: {},
    starterSuggestions: () => ({ starters: true }),
    threadReports: () => ({ reports: true }),
    threadReportSave: {},
    threadIncrementProgress: () => null,
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  squashAtomCommandFailure: (r: { error: Error }) => r.error,
}));
vi.mock("../../hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: state.openMenu }),
}));
vi.mock("../../browser/useOpenLink", () => ({ useOpenLink: () => state.openLink }));
vi.mock("../../env", () => ({ isElectron: false }));
const serverConfigFixture = vi.hoisted(() => ({ atom: {}, configs: new Map() }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === serverConfigFixture.atom ? serverConfigFixture.configs : [],
  useAtomRefresh: () => state.shellRefresh,
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: false, isPending: false, error: null }),
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: serverConfigFixture.atom,
  primaryServerKeybindingsAtom: {},
  primaryServerConfigAtom: {},
  serverEnvironment: { updateSettings: {} },
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { update: {} } }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../hooks/useMediaQuery", () => ({
  // Width queries answer with the phone layout; a touch-pointer query answers with the
  // on-screen keyboard, at any width.
  useMediaQuery: (query: unknown) =>
    typeof query === "string" && query.includes("pointer: coarse") ? state.coarse : state.phone,
}));
vi.mock("../../hooks/useSettings", async () => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@specweave-studio/contracts");
  return {
    useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS,
    mergeEnvironmentSettings: (server: object, client: object) => ({ ...client, ...server }),
    persistClientSettingsPatch: async () => {},
    useProjectOverrideWriteMode: () => "per-key" as const,
    usePrimarySettings: (select?: (settings: typeof DEFAULT_SERVER_SETTINGS) => unknown) =>
      select ? select(DEFAULT_SERVER_SETTINGS) : DEFAULT_SERVER_SETTINGS,
    useClientSettings: (
      select?: (settings: {
        sendShortcut: string;
        projectCoordinatorMachines: Record<string, string>;
        timelineDetail: "concise" | "normal" | "verbose";
        threadTimelineDetail: Record<string, never>;
      }) => unknown,
    ) => {
      const settings = {
        sendShortcut: state.sendShortcut,
        projectCoordinatorMachines: state.savedMachines,
        timelineDetail: state.timelineDetail,
        threadTimelineDetail: {},
      };
      return select ? select(settings) : settings;
    },
    useClientSettingsHydrationStatus: () => "ready",
    useUpdateClientSettings:
      () => (patch: { projectCoordinatorMachines?: Record<string, string> }) => {
        if (patch.projectCoordinatorMachines)
          state.savedMachines = patch.projectCoordinatorMachines;
      },
  };
});
vi.mock("./shell/CoordinatorModelPicker", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shell/CoordinatorModelPicker")>();
  return {
    CoordinatorModelPicker: (props: Parameters<typeof actual.CoordinatorModelPicker>[0]) => {
      if (state.realCoordinatorModelPicker) return <actual.CoordinatorModelPicker {...props} />;
      const { value, running, disabled, onChange } = props;
      return (
        <>
          <button
            data-coordinator-model
            data-running-instance={running?.value.instanceId}
            data-returns-to={running?.returnsTo}
            data-fallback-reason={running?.reason ?? undefined}
            data-disabled={disabled ? "true" : "false"}
            onClick={() => onChange({ instanceId: "codex-native" as never, model: "picked-model" })}
          >
            {(running?.value ?? value)?.model ?? "none"}
          </button>
          {running?.onSwitchBack ? (
            <button data-coordinator-switch-back onClick={running.onSwitchBack}>
              Back
            </button>
          ) : null}
        </>
      );
    },
  };
});
vi.mock("./shell/ModelBadge", () => ({
  ModelBadge: ({ model }: { model: string }) => <span data-model-badge>{model}</span>,
  ThreadModelBadge: ({ thread }: { thread: EnvironmentThreadShell }) => (
    <span data-model-badge>{(thread.modelIdentity?.current ?? thread.modelSelection).model}</span>
  ),
  ModelBadgeMark: () => null,
  useProviderEntries: () => new Map(),
  useProviderEntriesByEnvironment: () => new Map(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  // No `?pane=` deep link in these tests.
  useSearch: () => null,
  useRouter: () => ({ navigate: state.navigate }),
  Link: ({ children, ...p }: React.PropsWithChildren) => <a {...p}>{children}</a>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn<FixtureProcedure>() } }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children, ...p }: React.PropsWithChildren) => (
    <section {...p}>{children}</section>
  ),
}));
vi.mock("../ChatMarkdown", async () => {
  const { parseStudioThreadHref } = await import("../../studio/studioThreadLinks");
  const { memo, useLayoutEffect } = await import("react");
  // Plain text, except thread links, which go through the caller like the real renderer.
  // Memoized like the real one, and counted, so tests can tell which messages rendered.
  return {
    default: memo(function MarkdownStandIn({
      text,
      renderContextReference,
      renderThreadLink,
    }: {
      text: string;
      renderContextReference?: (reference: {
        kind: string;
        contextId: string;
        label: string;
      }) => React.ReactNode;
      renderThreadLink?: (link: {
        candidates: readonly string[];
        label: string;
      }) => React.ReactNode | null;
    }) {
      // Counted once a render commits; a memoized render that was skipped is not.
      useLayoutEffect(() => {
        state.markdownRenders += 1;
      });
      return (
        <p>
          {text
            .split(/(\[[^\]]+\]\((?:studio-context:\/\/v1\/thread\/|studio:\/\/thread\/)[^)]+\))/)
            .map((part, index) => {
              const context = /^\[([^\]]+)\]\(studio-context:\/\/v1\/thread\/([^)]+)\)$/.exec(part);
              if (context && renderContextReference)
                return (
                  <span key={index}>
                    {renderContextReference({
                      kind: "thread",
                      contextId: decodeURIComponent(context[2]!),
                      label: context[1]!,
                    })}
                  </span>
                );
              const thread = /^\[([^\]]+)\]\((studio:\/\/thread\/[^)]+)\)$/.exec(part);
              const candidates = thread ? parseStudioThreadHref(thread[2]!) : null;
              if (thread && candidates)
                return (
                  <span key={index}>
                    {renderThreadLink?.({ candidates, label: thread[1]! }) ?? (
                      <span data-fallback-thread-link={candidates[0]}>{thread[1]}</span>
                    )}
                  </span>
                );
              return part;
            })}
        </p>
      );
    }),
  };
});
vi.mock("./ProjectWorkspaceAttachments", () => ({
  ProjectWorkspaceAttachments: ({
    attachments,
  }: {
    attachments: import("@specweave-studio/contracts").ChatAttachment[];
  }) => (
    <div data-message-attachments>
      {attachments.map((a) => (
        <span key={a.id}>{a.name}</span>
      ))}
    </div>
  ),
}));
vi.mock("./ProjectWorkspaceSettings", () => ({
  ProjectWorkspaceSettings: (props: { initialTab: string; initialRow?: string | null }) => (
    <div data-settings-tab={props.initialTab} data-settings-row={props.initialRow ?? ""} />
  ),
}));
vi.mock("../../studio/useProjectFolderHealth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../studio/useProjectFolderHealth")>();
  return {
    ...actual,
    useProjectFolderHealth: (project: Parameters<typeof actual.useProjectFolderHealth>[0]) =>
      state.realFolderHealth ? actual.useProjectFolderHealth(project) : state.folderHealth,
  };
});
vi.mock("./RemoteWorkerCards", () => ({ RemoteWorkerCards: () => null }));
vi.mock("../../studio/useProjectAttention", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../studio/useProjectAttention")>();
  const { aggregateProjectAttention } =
    await import("@specweave-studio/client-runtime/state/projectAttention");
  return {
    ...actual,
    useProjectAttention: (
      threads: EnvironmentThreadShell[],
      projects: import("../../studio/useProjectAttention").AttentionProjectMember[],
    ) => {
      const members = actual.expandAttentionProjects(projects).map((project) => ({
        environmentId: project.environmentId,
        projectId: project.id,
        coordinatorThreadId:
          project.workspaceSettings?.coordinatorThreadId ?? `project-coordinator:${project.id}`,
        includeUserRoots: Boolean(project.workspaceSettings?.logicalProject),
        freshness:
          !state.connected || state.offlineHosts.includes(project.environmentId)
            ? ("offline" as const)
            : !state.shellsBootstrapped
              ? ("empty" as const)
              : ("live" as const),
        remoteWorkers: [],
        remoteWorkersComplete: true,
      }));
      return aggregateProjectAttention({
        members,
        roots: actual.projectAttentionRoots(threads, members),
        threads,
      });
    },
  };
});
vi.mock("../../studio/fleet", () => ({
  useProjectRemoteWorkers: () => ({ workers: [], available: false, refresh: () => {} }),
  useStudioFleet: () => ({ snapshot: null, loading: false, failed: false, refresh: () => {} }),
}));
vi.mock("./shell/LibraryPane", () => ({ LibraryPane: () => <p>Library pane</p> }));
// The handoff dialog reads the source checkout's git status; these surfaces never open it.
vi.mock("./useHandoffSourceChanges", () => ({
  useHandoffSourceChanges: () => ({
    state: "unknown",
    fileCount: 0,
    committing: false,
    error: null,
    onCommit: null,
  }),
}));
vi.mock("../ChatView", async () => {
  const { useProjectMessageRouting, routeProjectComposerSend } =
    await import("../../studio/projectMessageRouting");
  const { continueWithProjectModel } = await import("../../studio/coordinatorContinuation");
  const { useOpenThread } = await import("../../hooks/useOpenThread");
  return {
    default: ({
      threadId,
      reviewOnly,
      suspendShortcuts,
    }: {
      threadId: string;
      reviewOnly?: boolean;
      suspendShortcuts?: boolean;
    }) => {
      const routing = useProjectMessageRouting();
      state.routing = routing;
      const { openThread } = useOpenThread();
      return (
        <section
          data-native-thread={threadId}
          data-native-review={reviewOnly ? "" : undefined}
          data-native-suspend={suspendShortcuts ? "" : undefined}
        >
          {!reviewOnly && routing?.coordinatorModelControls}
          {["Resume", "Plan"].map((kind) => (
            <button
              key={kind}
              onClick={() =>
                void continueWithProjectModel(routing, undefined, (selection) =>
                  state.nativeContinue(kind, selection),
                ).catch((error) => {
                  state.nativeError = error.message;
                })
              }
            >
              {kind} native
            </button>
          ))}
          <button
            onClick={() =>
              void openThread({
                environmentId: "host" as never,
                threadId: state.relatedThreadId as never,
              })
            }
          >
            Open related thread
          </button>
          <button
            onClick={() =>
              void routeProjectComposerSend(routing, {
                prompt: "Continue this worker",
                hasOtherContent: false,
                nativeInput: false,
                prepareAttachments: async () => state.attachments,
                clear: () => {},
                reportError: () => {},
              })
            }
          >
            Reply in selected thread
          </button>
        </section>
      );
    },
  };
});
import { ProjectWorkspace } from "./ProjectWorkspace";
import { resetProjectFolderChecksForTests } from "../../studio/useProjectFolderHealth";
import { forgetCoordinatorPlaces } from "./CoordinatorConversation";
import { enqueueProjectCoordinatorDraft } from "../../studio/projectCoordinatorDraft";
import { getProjectCoordinatorComposer } from "../../studio/projectCoordinatorComposer";
let root: Root, container: HTMLDivElement;
function shell(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id,
    environmentId: "host",
    projectId: "project",
    title: `Thread ${id}`,
    createdBy: "agent",
    runtime: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    settledOverride: null,
    lineage: { relationshipToParent: null },
    pullRequests: [],
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-10-09T01:00:00Z",
    modelSelection: {
      instanceId: id === "coord" ? "claude-native" : "codex-native",
      model: "chosen-model",
    },
    ...overrides,
  } as EnvironmentThreadShell;
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  forgetCoordinatorPlaces();
  Element.prototype.scrollIntoView = vi.fn<FixtureProcedure>();
  const composer = getProjectCoordinatorComposer("host", "project");
  composer.setPrompt("");
  composer.setAttachments([]);
  composer.setPreparing([]);
  composer.setProblem(null);
  composer.setSubmitting(false);
  composer.outgoing.clear();
  state.attachments = [];
  state.messages = [];
  state.threadReports = null;
  state.runs = [];
  state.turnItems = [];
  state.runtimeRequests = [];
  state.detailStatus = "live";
  state.shellRefresh.mockReset();
  state.send.mockReset();
  state.navigate.mockReset();
  state.relatedThreadId = "worker";
  state.send.mockResolvedValue({ _tag: "Success", value: { threadId: "coord", created: false } });
  state.settle.mockReset();
  state.refresh.mockReset();
  localStorage.clear();
  state.coordinatorId = "coord";
  state.coordinatorModel = { instanceId: "claude-native", model: "coordinator-model" };
  state.realCoordinatorModelPicker = false;
  state.goal = "";
  state.git = null;
  state.pullRequestRequests = [];
  state.expireResult = false;
  state.canWriteSourceControl = null;
  state.detailsPanelsShown = [];
  state.openLink.mockClear();
  state.starters = null;
  state.startersPending = false;
  state.projectReadPending = false;
  state.startersError = null;
  state.starterReads = 0;
  state.providers = [];
  state.hostSettings = undefined;
  state.serverConfigPending = false;
  state.project.defaultModelSelection = { instanceId: "codex-native", model: "worker-model" };
  state.otherCheckouts = [];
  state.recoveryHosts = [];
  state.offlineHosts = [];
  state.pairedHosts = [];
  state.syncingHosts = [];
  state.folderHealth = "unknown";
  state.realFolderHealth = false;
  state.projectKind = undefined;
  resetProjectFolderChecksForTests();
  state.savedMachines = {};
  state.nativeError = null;
  sessionStorage.clear();
  state.connected = true;
  state.canOperate = true;
  state.projectLoaded = true;
  state.shellsBootstrapped = true;
  state.primaryRegistered = true;
  state.phone = false;
  state.coarse = false;
  state.sendShortcut = "enter";
  state.timelineDetail = "normal";
  state.uploadsSupported = true;
  state.questionAttachments = true;
  state.uploadFails = false;
  state.uploadsStarted = [];
  state.uploadsReleased = [];
  state.uploads = {};
  state.uploadGate = null;
  state.maxFileBytes = 50 * 1024 * 1024;
  state.prepareImage.mockReset();
  state.prepareImage.mockImplementation(async (file: File) =>
    /\.hei[cf]$/i.test(file.name)
      ? {
          ok: true,
          recompressed: true,
          file: new File(["jpeg"], file.name.replace(/\.hei[cf]$/i, ".jpg"), {
            type: "image/jpeg",
          }),
        }
      : file.size <= 10 * 1024 * 1024
        ? { ok: true, recompressed: false, file }
        : { ok: false, reason: "too-large" },
  );
  // jsdom has neither; each test gets fresh ones.
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn<FixtureProcedure>();
  state.shells = [
    shell("coord"),
    shell("worker"),
    shell("foreign", { projectId: "another" as EnvironmentThreadShell["projectId"] }),
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete window.desktopBridge;
});
/** A file in the repository, found from wherever the test runner started. */
function repoFile(relative: string): Promise<string> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let directory = process.cwd();
      while (!(yield* fs.exists(path.join(directory, relative)))) {
        const parent = path.dirname(directory);
        if (parent === directory) throw new Error(`${relative} not found above ${process.cwd()}`);
        directory = parent;
      }
      return path.join(directory, relative);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

async function render() {
  await act(async () => root.render(<ProjectWorkspace projectKey="atlas" />));
}
async function openFirstThread() {
  const row = container.querySelector<HTMLButtonElement>(".sws-thread-open");
  expect(row).not.toBeNull();
  await act(async () => row!.click());
}
async function press(init: KeyboardEventInit) {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  });
}
async function click(text: string) {
  const b = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  expect(b).toBeDefined();
  await act(async () => b!.click());
}
async function prompt(value: string) {
  const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
      input,
      value,
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function paste(files: File[], type = "paste", items: unknown[] = [], text = "") {
  const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, type === "paste" ? "clipboardData" : "dataTransfer", {
    value: { files, items, types: ["Files"], getData: () => text },
  });
  await act(async () => {
    input.dispatchEvent(event);
  });
  return event;
}
const png = (name = "shot.png", type = "image/png") => new File(["x"], name, { type });
const sized = (name: string, bytes: number) => {
  const file = png(name);
  Object.defineProperty(file, "size", { value: bytes });
  return file;
};
const sendButton = () =>
  container.querySelector<HTMLButtonElement>("[aria-label='Send to coordinator']")!;
const alertText = () => container.querySelector(".sws-composer [role='alert']")?.textContent ?? "";
function recreateRoot() {
  root = createRoot(container);
}

export {
  notifyUploads,
  state,
  projectRead,
  root,
  container,
  shell,
  repoFile,
  render,
  openFirstThread,
  press,
  click,
  prompt,
  paste,
  png,
  sized,
  sendButton,
  alertText,
  recreateRoot,
};

vi.mock("../../state/shell", () => ({ environmentShell: { stateAtom: () => ({}) } }));
