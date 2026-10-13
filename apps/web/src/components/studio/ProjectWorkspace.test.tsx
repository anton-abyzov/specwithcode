// @vitest-environment jsdom
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";

const state = vi.hoisted(() => ({
  send: vi.fn(),
  nativeContinue: vi.fn(async (_kind: string, _selection: unknown) => {}),
  nativeError: null as string | null,
  openLink: vi.fn(async () => undefined),
  openMenu: vi.fn(async () => undefined),
  refresh: vi.fn(),
  settle: vi.fn(),
  navigate: vi.fn(),
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
  runs: [] as Array<{ id: string; ordinal: number; status: string; requestedAt: string }>,
  turnItems: [] as Array<{
    runId: string;
    ordinal: number;
    type: string;
    status: string;
    toolName?: string;
  }>,
  coordinatorId: "coord" as string | null,
  coordinatorModel: { instanceId: "claude-native", model: "coordinator-model" } as {
    instanceId: string;
    model: string;
  } | null,
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
  /** The host has not sent its configuration (and so its providers) yet. */
  serverConfigPending: false,
  phone: false,
  /** Touch is the primary pointer (a phone or tablet), not a mouse or trackpad. */
  coarse: false,
  sendShortcut: "enter",
  uploadsSupported: true,
  uploadFails: false,
  uploadsStarted: [] as string[],
  uploadsReleased: [] as string[],
  uploads: {} as Record<string, unknown>,
  uploadGate: null as Promise<void> | null,
  maxFileBytes: (50 * 1024 * 1024) as number | null,
  /** Stands in for HEIC conversion and shrinking, which jsdom cannot decode. */
  prepareImage: vi.fn(),
  /** Other machines' checkouts of the project. */
  otherCheckouts: [] as Array<{ id: string; environmentId: string; workspaceRoot: string }>,
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
vi.mock("../../lib/archivedThreadsState", () => ({
  useArchivedThreadSnapshots: () => ({ snapshots: [], error: null }),
}));
vi.mock("../../state/entities", () => ({
  useAllEnvironmentShellsBootstrapped: () => state.shellsBootstrapped,
  useProjects: () => (state.projectLoaded ? [state.project, ...state.otherCheckouts] : []),
  useThreadShells: () => state.shells,
  readThreadShells: () => state.shells,
  useThreadProjection: () => ({
    projection: { messages: state.messages, runs: state.runs, turnItems: state.turnItems },
  }),
  useThreadHistory: () => ({ hasMoreHistory: false }),
  useThreadStatus: () => "ready",
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ isReady: true, environments: [] }),
  usePrimaryEnvironmentId: () => (state.primaryRegistered ? "primary" : null),
  useEnvironment: () => ({
    label: "Test host",
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.serverConfigPending
      ? undefined
      : {
          providers: state.providers,
          environment: {
            capabilities: {
              attachmentUploads: state.uploadsSupported,
              ...(state.maxFileBytes === null
                ? {}
                : { fileAttachments: { maxUploadBytes: state.maxFileBytes } }),
            },
          },
        },
  }),
}));
vi.mock("../../lib/attachmentUploadQueue", () => ({
  useAttachmentUploadStore: (select: (store: { uploadsByImageId: object }) => unknown) =>
    select({ uploadsByImageId: state.uploads }),
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
vi.mock("../../state/session", () => ({
  useEnvironmentsWithScope: () => new Set(),
  useEnvironmentScope: (_environmentId: string, scope: string) =>
    scope === "source-control:write"
      ? (state.canWriteSourceControl ?? state.canOperate)
      : state.canOperate,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { starters?: true; reports?: true } | null) => {
    if (query === null) return { data: null, isPending: false, error: null, refresh: vi.fn() };
    if (query.reports) {
      return { data: state.threadReports, isPending: false, error: null, refresh: state.refresh };
    }
    if (query.starters) {
      state.starterReads += 1;
      return {
        data: state.starters,
        isPending: state.startersPending,
        error: state.startersError,
        refresh: vi.fn(),
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
        },
        memory: { files: [], totalBytes: 0 },
      },
  isPending: state.projectReadPending,
  refresh: state.refresh,
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.send }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { loadEarlierHistory: {} } }));
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
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("../../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { update: {} } }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../../hooks/useMediaQuery", () => ({
  // Width queries answer with the phone layout; a touch-pointer query answers with the
  // on-screen keyboard, at any width.
  useMediaQuery: (query: unknown) =>
    typeof query === "string" && query.includes("pointer: coarse") ? state.coarse : state.phone,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (
    select: (settings: {
      sendShortcut: string;
      projectCoordinatorMachines: Record<string, string>;
    }) => unknown,
  ) =>
    select({ sendShortcut: state.sendShortcut, projectCoordinatorMachines: state.savedMachines }),
  useClientSettingsHydrationStatus: () => "ready",
  useUpdateClientSettings:
    () => (patch: { projectCoordinatorMachines?: Record<string, string> }) => {
      if (patch.projectCoordinatorMachines) state.savedMachines = patch.projectCoordinatorMachines;
    },
}));
vi.mock("./shell/CoordinatorModelPicker", () => ({
  CoordinatorModelPicker: ({
    value,
    disabled,
    onChange,
  }: {
    value: { instanceId: string; model: string } | null;
    disabled: boolean;
    onChange: (value: { instanceId: string; model: string }) => void;
  }) => (
    <button
      data-coordinator-model
      data-disabled={disabled ? "true" : "false"}
      onClick={() => onChange({ instanceId: "codex-native", model: "picked-model" })}
    >
      {value?.model ?? "none"}
    </button>
  ),
}));
vi.mock("./shell/ProjectUsageIndicator", () => ({
  ProjectUsageIndicator: ({ onOpenProjectUsage }: { onOpenProjectUsage: () => void }) => (
    <button data-usage-indicator onClick={onOpenProjectUsage}>
      usage
    </button>
  ),
}));
vi.mock("./shell/ModelBadge", () => ({
  ModelBadge: ({ model }: { model: string }) => <span data-model-badge>{model}</span>,
  useProviderEntries: () => new Map(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  Link: ({ children, ...p }: React.PropsWithChildren) => <a {...p}>{children}</a>,
}));
vi.mock("../WorkspacePageHeader", () => ({
  WorkspacePageHeader: ({ children }: React.PropsWithChildren) => <header>{children}</header>,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("../ui/sidebar", () => ({
  SidebarInset: ({ children, ...p }: React.PropsWithChildren) => (
    <section {...p}>{children}</section>
  ),
}));
vi.mock("../ChatMarkdown", async () => {
  const { parseStudioThreadHref } = await import("../../studio/studioThreadLinks");
  // Plain text, except thread links, which go through the caller like the real renderer.
  return {
    default: ({
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
    }) => (
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
    ),
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
vi.mock("./ProjectWorkspaceSettings", () => ({ ProjectWorkspaceSettings: () => null }));
vi.mock("./RemoteWorkerCards", () => ({ RemoteWorkerCards: () => null }));
vi.mock("../../studio/fleet", () => ({
  useProjectRemoteWorkers: () => ({ workers: [], available: false, refresh: () => {} }),
}));
vi.mock("./shell/LibraryPane", () => ({ LibraryPane: () => <p>Library pane</p> }));
vi.mock("../ChatView", async () => {
  const { useProjectMessageRouting, routeProjectComposerSend } =
    await import("../../studio/projectMessageRouting");
  const { continueWithProjectModel } = await import("../../studio/coordinatorContinuation");
  const { useOpenThread } = await import("../../hooks/useOpenThread");
  return {
    default: ({ threadId }: { threadId: string }) => {
      const routing = useProjectMessageRouting();
      state.routing = routing;
      const { openThread } = useOpenThread();
      return (
        <section data-native-thread={threadId}>
          {routing?.coordinatorModelControls}
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
  Element.prototype.scrollIntoView = vi.fn();
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
  state.send.mockReset();
  state.navigate.mockReset();
  state.relatedThreadId = "worker";
  state.send.mockResolvedValue({ _tag: "Success", value: { threadId: "coord", created: false } });
  state.settle.mockReset();
  state.refresh.mockReset();
  localStorage.clear();
  state.coordinatorId = "coord";
  state.coordinatorModel = { instanceId: "claude-native", model: "coordinator-model" };
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
  state.serverConfigPending = false;
  state.project.defaultModelSelection = { instanceId: "codex-native", model: "worker-model" };
  state.otherCheckouts = [];
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
  state.uploadsSupported = true;
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
  URL.revokeObjectURL = vi.fn();
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
function repoFile(relative: string): string {
  let directory = process.cwd();
  while (!NodeFS.existsSync(NodePath.join(directory, relative))) {
    const parent = NodePath.dirname(directory);
    if (parent === directory) throw new Error(`${relative} not found above ${process.cwd()}`);
    directory = parent;
  }
  return NodePath.join(directory, relative);
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
  const b = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
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
describe("coordinator image attachments", () => {
  it("attaches a pasted image and sends it with the message", async () => {
    await render();
    const event = await paste([png()]);
    expect(event.defaultPrevented).toBe(true);
    expect(state.uploadsStarted).toHaveLength(1);
    const strip = container.querySelector(".sws-attachments")!;
    expect(strip.querySelectorAll("img")).toHaveLength(1);
    await prompt("What is wrong here?");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Send to coordinator']")!.click(),
    );
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]![0].input).toMatchObject({
      prompt: "What is wrong here?",
      attachments: [{ type: "image", id: "pending-0", name: "shot.png", mimeType: "image/png" }],
    });
    expect(container.querySelector(".sws-attachments")).toBeNull();
  });
  it("sends an image on its own, with no words", async () => {
    await render();
    const send = () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Send to coordinator']")!;
    expect(send().disabled).toBe(true);
    await paste([png()]);
    expect(send().disabled).toBe(false);
    await act(async () => send().click());
    expect(state.send.mock.calls[0]![0].input.attachments).toHaveLength(1);
  });
  it("leaves pasted text alone", async () => {
    await render();
    const event = await paste([]);
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector(".sws-attachments")).toBeNull();
  });
  it("takes a dropped image and removes it on request", async () => {
    await render();
    await paste([png("drop.png")], "drop");
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Remove drop.png']")!.click(),
    );
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(state.uploadsReleased).toEqual(state.uploadsStarted);
  });
  it("attaches an image type no provider reads as a file", async () => {
    await render();
    await paste([png("scan.tiff", "image/tiff")]);
    const tile = container.querySelector(".sws-attachment")!;
    expect(tile.getAttribute("data-kind")).toBe("file");
    expect(tile.querySelector("img")).toBeNull();
    expect(alertText()).toBe("");
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments).toMatchObject([
      { type: "file", name: "scan.tiff", mimeType: "image/tiff" },
    ]);
  });
  it("says why a file it cannot send was not attached", async () => {
    state.maxFileBytes = null;
    await render();
    await paste([png("scan.tiff", "image/tiff")]);
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(alertText()).toContain("'scan.tiff' is not an image, and this host takes images only");
  });
  it("keeps the draft and the image when the upload did not finish", async () => {
    state.uploadFails = true;
    await render();
    await paste([png()]);
    await prompt("Look");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Send to coordinator']")!.click(),
    );
    expect(state.send).not.toHaveBeenCalled();
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("Look");
    expect(container.querySelector(".sws-composer [role='alert']")?.textContent).toContain(
      "did not upload",
    );
  });
  it("says so when the host takes no attachments", async () => {
    state.uploadsSupported = false;
    await render();
    await paste([png()]);
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(container.querySelector(".sws-composer [role='alert']")?.textContent).toContain(
      "does not accept attachments",
    );
  });
  it("attaches what the file picker returns", async () => {
    await render();
    const picker = container.querySelector<HTMLInputElement>(".sws-composer input[type='file']")!;
    Object.defineProperty(picker, "files", { value: [png("pick.png")], configurable: true });
    await act(async () => {
      picker.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.querySelector("[aria-label='Remove pick.png']")).not.toBeNull();
    expect(state.uploadsStarted).toHaveLength(1);
  });
  it("lets a file be dragged onto the message, and answers one it cannot take", async () => {
    await render();
    const over = await paste([], "dragover");
    expect(over.defaultPrevented).toBe(true);
    const dropped = await paste(
      [new File(["x"], "notes.pdf", { type: "application/pdf" })],
      "drop",
    );
    expect(dropped.defaultPrevented).toBe(true);
    expect(container.querySelector("[aria-label='Preview notes.pdf']")).not.toBeNull();
    await paste([new File([], "empty.txt", { type: "text/plain" })], "drop");
    expect(alertText()).toContain("'empty.txt' is empty or could not be read");
    const video = new File(["x"], "video.mov", { type: "video/quicktime" });
    Object.defineProperty(video, "size", { value: 60 * 1024 * 1024 });
    await paste([video], "drop");
    expect(alertText()).toContain("'video.mov' exceeds the 50 MB attachment limit");
  });
  it("takes a photo that arrives with no type, and a screenshot offered only as an item", async () => {
    await render();
    await paste([png("photo.jpg", "")], "drop");
    await paste([], "paste", [{ kind: "file", getAsFile: () => png("item.png") }]);
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(2);
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments[0].mimeType).toBe("image/jpeg");
  });
  it("prepares every image the way the thread composer does before it attaches", async () => {
    // A 6 MB screenshot is under the host's per-image cap but over what the
    // provider takes, so it must shrink like a thread image, not go as is.
    const shrunk = sized("retina.jpg", 3 * 1024 * 1024);
    state.prepareImage.mockResolvedValueOnce({ ok: true, recompressed: true, file: shrunk });
    await render();
    await paste([sized("retina.png", 6 * 1024 * 1024)]);
    expect(state.prepareImage).toHaveBeenCalledTimes(1);
    // The thread composer's own budget, not the host's 10 MB cap.
    expect(state.prepareImage.mock.calls[0]![1]).toBeUndefined();
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments).toMatchObject([
      { type: "image", name: "retina.jpg", sizeBytes: 3 * 1024 * 1024 },
    ]);
  });
  it("shrinks an image over 10 MB, and says so when it cannot", async () => {
    const shrunk = sized("huge.webp", 4 * 1024 * 1024);
    state.prepareImage.mockResolvedValueOnce({ ok: true, recompressed: true, file: shrunk });
    await render();
    await paste([sized("huge.png", 11 * 1024 * 1024)]);
    expect(state.prepareImage).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[aria-label='Preview huge.webp']")).not.toBeNull();
    await paste([sized("giant.png", 70 * 1024 * 1024)]);
    expect(alertText()).toContain("'giant.png' is too large to attach, even after shrinking it.");
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
  });
  it("adds the images that fit under the 20 image limit and says how many were left out", async () => {
    await render();
    await paste(Array.from({ length: 14 }, (_, index) => png(`a${index}.png`)));
    expect(container.querySelector(".sws-attachment-count")).toBeNull();
    await paste([png("a14.png")]);
    expect(container.querySelector(".sws-attachment-count")?.textContent).toBe("15 of 20 images");
    await paste(Array.from({ length: 8 }, (_, index) => png(`b${index}.png`)));
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(20);
    expect(container.querySelector(".sws-attachment-count")?.textContent).toBe("20 of 20 images");
    expect(alertText()).toBe(
      "You can attach up to 20 images per message. 3 images were not added.",
    );
    // The notice stays until it is dismissed.
    await prompt("Still here");
    expect(alertText()).toContain("3 images were not added");
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".sws-composer [aria-label='Dismiss']")!.click(),
    );
    expect(alertText()).toBe("");
    // Files still fit beside a full set of images.
    await paste([new File(["x"], "notes.md", { type: "text/markdown" })], "drop");
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(21);
  });
  it("refuses a set of images the host would reject for its total size", async () => {
    await render();
    await paste(
      Array.from({ length: 4 }, (_, index) => sized(`big${index}.png`, 9.5 * 1024 * 1024)),
    );
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(2);
    expect(alertText()).toBe("Images can total up to 22 MB per message. 2 images were not added.");
  });
  it("converts a HEIC photo to JPEG before it attaches", async () => {
    let finish = () => {};
    state.prepareImage.mockImplementationOnce(
      (file: File) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({
              ok: true,
              recompressed: true,
              file: new File(["jpeg"], file.name.replace(".heic", ".jpg"), { type: "image/jpeg" }),
            });
        }),
    );
    await render();
    await paste([png("IMG_0001.heic", "image/heic")], "drop");
    expect(container.querySelector(".sws-attachment[data-state='preparing']")).not.toBeNull();
    expect(sendButton().disabled).toBe(true);
    // Enter waits too, without an error that would outlast the preparation.
    await prompt("Here it is");
    await act(async () => {
      container
        .querySelector("#project-prompt")!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
    });
    expect(state.send).not.toHaveBeenCalled();
    expect(alertText()).toBe("");
    await act(async () => finish());
    expect(container.querySelector(".sws-attachment[data-state='preparing']")).toBeNull();
    expect(container.querySelector("[aria-label='Preview IMG_0001.jpg']")).not.toBeNull();
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments).toMatchObject([
      { type: "image", name: "IMG_0001.jpg", mimeType: "image/jpeg" },
    ]);
  });
  it("attaches a pasted file instead of ignoring it", async () => {
    await render();
    const event = await paste([new File(["a,b"], "data.csv", { type: "text/csv" })]);
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector("[aria-label='Preview data.csv']")).not.toBeNull();
    expect(container.querySelector(".sws-attachment-size")?.textContent).toBe("1 KB");
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments).toMatchObject([
      { type: "file", name: "data.csv", mimeType: "text/csv", sizeBytes: 3 },
    ]);
  });
  it("leaves a file to the browser when the clipboard also carries real text", async () => {
    await render();
    const event = await paste(
      [new File(["{}"], "styles.rtf", { type: "text/rtf" })],
      "paste",
      [],
      "Some copied prose",
    );
    expect(event.defaultPrevented).toBe(false);
    expect(container.querySelector(".sws-attachments")).toBeNull();
  });
  it("opens a composer image full screen over every attached image", async () => {
    let urls = 0;
    URL.createObjectURL = vi.fn(() => `blob:preview-${urls++}`);
    await render();
    await paste([png("one.png"), png("two.png"), png("three.png")]);
    const open = container.querySelector<HTMLButtonElement>("[aria-label='Preview two.png']")!;
    expect(open.className).toContain("sws-attachment-open");
    await act(async () => open.click());
    const lightbox = document.querySelector("[data-lightbox]")!;
    expect(lightbox.getAttribute("data-index")).toBe("1");
    expect(lightbox.textContent).toContain("one.png,two.png,three.png");
    await act(async () =>
      document.querySelector<HTMLButtonElement>("[data-lightbox] button")!.click(),
    );
    expect(document.querySelector("[data-lightbox]")).toBeNull();
  });
  it("removes an image without opening its preview", async () => {
    await render();
    await paste([png("one.png"), png("two.png")]);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Remove one.png']")!.click(),
    );
    expect(document.querySelector("[data-lightbox]")).toBeNull();
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
  });
  it("opens an attached file's preview from its chip", async () => {
    await render();
    await paste([new File(["# Plan"], "plan.md", { type: "text/markdown" })], "drop");
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Preview plan.md']")!.click(),
    );
    expect(document.querySelector("[data-file-preview='plan.md']")?.textContent).toBe(
      "local bytes",
    );
  });
  it("shows each upload's state and says which image failed", async () => {
    await render();
    await paste([png("one.png"), png("two.png"), png("three.png")]);
    const [one, two, three] = state.uploadsStarted;
    state.uploads = {
      [one!]: { status: "ready", environmentId: "host", attachmentId: "a" },
      [two!]: { status: "uploading", environmentId: "host", progress: 0.42 },
      [three!]: { status: "failed", environmentId: "host", reason: "offline" },
    };
    await paste([]);
    await prompt("x");
    const tiles = [...container.querySelectorAll(".sws-attachment")];
    expect(tiles.map((tile) => tile.getAttribute("data-state"))).toEqual([
      "ready",
      "uploading",
      "failed",
    ]);
    expect(tiles.map((tile) => tile.querySelector(".sws-attachment-state")?.textContent)).toEqual([
      undefined,
      "42%",
      "Failed",
    ]);
    // One spoken line for the strip, never a percentage per image.
    const spoken = [...container.querySelectorAll(".sws-composer [role='status']")].map(
      (node) => node.textContent,
    );
    expect(spoken).toContain("three.png did not upload.");
    expect(container.querySelector(".sws-attachment-state[role]")).toBeNull();
  });
  it("holds the composer while images upload, and sends once", async () => {
    let open = () => {};
    state.uploadGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    await render();
    await paste([png()]);
    await prompt("First words");
    await act(async () => sendButton().click());
    expect(state.send).not.toHaveBeenCalled();
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().textContent).toContain("Sending");
    expect(
      container.querySelector<HTMLButtonElement>("[aria-label='Remove shot.png']")!.disabled,
    ).toBe(true);
    // A second Enter while the first send waits changes nothing.
    await act(async () => {
      container
        .querySelector("#project-prompt")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await act(async () => {
      open();
      await state.uploadGate;
    });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]![0].input.prompt).toBe("First words");
    expect(container.querySelector(".sws-composer [role='alert']")).toBeNull();
    expect(sendButton().textContent).not.toContain("Sending");
  });
  it("keeps the images and the request identity when delivery is not confirmed", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Host went away") });
    await render();
    await paste([png()]);
    await prompt("Look at this");
    await act(async () => sendButton().click());
    expect(alertText()).toContain("Host went away");
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
    expect(state.uploadsReleased).toEqual([]);
    await act(async () => sendButton().click());
    expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.send.mock.calls[1]![0].input.commandId).toBe(
      state.send.mock.calls[0]![0].input.commandId,
    );
    expect(state.send.mock.calls[1]![0].input.attachments).toEqual(
      state.send.mock.calls[0]![0].input.attachments,
    );
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(state.uploadsReleased).toEqual(state.uploadsStarted);
  });
  it("does not hold an image it has no right to upload", async () => {
    state.canOperate = false;
    await render();
    await paste([png()]);
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(state.uploadsStarted).toEqual([]);
    expect(alertText()).toContain("Reconnect to this host");
  });
  it("clears an attachment notice once a message is sent", async () => {
    state.maxFileBytes = null;
    await render();
    await paste([png("scan.tiff", "image/tiff")]);
    expect(alertText()).toContain("takes images only");
    await prompt("Just words");
    await act(async () => sendButton().click());
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".sws-composer [role='alert']")).toBeNull();
  });
  it("returns focus to the message after removing an image", async () => {
    await render();
    await paste([png()]);
    const remove = container.querySelector<HTMLButtonElement>("[aria-label='Remove shot.png']")!;
    remove.focus();
    await act(async () => remove.click());
    expect(document.activeElement?.id).toBe("project-prompt");
  });
  it("retains the exact prompt, file and preview across provider-settings navigation", async () => {
    await render();
    await paste([png()]);
    await prompt("  Review this screenshot\nwith exact whitespace  ");
    await act(async () => root.render(<div>Provider settings</div>));
    expect(state.uploadsReleased).toEqual([]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    await render();
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "  Review this screenshot\nwith exact whitespace  ",
    );
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input).toMatchObject({
      prompt: "  Review this screenshot\nwith exact whitespace  ",
      attachments: [{ name: "shot.png" }],
    });
    expect(state.uploadsReleased).toEqual(state.uploadsStarted);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });
  it("retains failed sends and their request identity across navigation", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Host went away") });
    await render();
    await paste([png()]);
    await prompt("Keep this request");
    await act(async () => sendButton().click());
    const request = state.send.mock.calls[0]![0];
    await act(async () => root.render(<div>Provider settings</div>));
    await render();
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "Keep this request",
    );
    expect(container.querySelectorAll(".sws-attachment")).toHaveLength(1);
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[1]![0]).toEqual(request);
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("");
    await act(async () => root.render(<div>Provider settings</div>));
    await render();
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("");
  });
  it("keeps a pending send locked across remount and preserves newer composer input", async () => {
    let finish!: (result: unknown) => void;
    state.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await paste([png()]);
    await prompt("First request");
    await act(async () => sendButton().click());
    await act(async () => root.render(<div>Provider settings</div>));
    await render();
    expect(sendButton().disabled).toBe(true);
    await prompt("My next request");
    await act(async () =>
      finish({ _tag: "Success", value: { threadId: "coord", created: false } }),
    );
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "My next request",
    );
    expect(container.querySelector(".sws-attachments")).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });
  it("finishes image preparation into the retained project draft while settings are open", async () => {
    let finish!: (value: unknown) => void;
    state.prepareImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await paste([png("photo.heic", "image/heic")]);
    await act(async () => root.render(<div>Provider settings</div>));
    await act(async () =>
      finish({ ok: true, recompressed: true, file: png("photo.jpg", "image/jpeg") }),
    );
    await render();
    expect(container.querySelector(".sws-attachment[data-state='preparing']")).toBeNull();
    expect(container.querySelector("[aria-label='Preview photo.jpg']")).not.toBeNull();
    await act(async () => sendButton().click());
    expect(state.send.mock.calls[0]![0].input.attachments[0].name).toBe("photo.jpg");
  });
  it("opens the file picker from the attach button", async () => {
    await render();
    const picker = container.querySelector<HTMLInputElement>(".sws-composer input[type='file']")!;
    const opened = vi.spyOn(picker, "click").mockImplementation(() => {});
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[aria-label='Attach files']")!.click(),
    );
    expect(opened).toHaveBeenCalledTimes(1);
    // Any file goes when the host takes files.
    expect(picker.accept).toBe("");
  });
});
describe("project coordinator surface", () => {
  it("keeps a thread's status and model together, apart from its error", async () => {
    state.shells = [
      shell("coord"),
      shell("worker", { runtime: { lastError: "You have hit your usage limit" } } as never),
    ];
    await render();
    const meta = container.querySelector("[data-thread-id='worker'] .sws-thread-meta")!;
    const lead = meta.querySelector(":scope > .sws-thread-lead")!;
    expect(lead.querySelector("[data-model-badge]")).not.toBeNull();
    const error = meta.querySelector(":scope > .sws-thread-error")!;
    expect(error.textContent).toBe("You have hit your usage limit");
    expect(lead.contains(error)).toBe(false);
  });
  it("shows the retained coordinator model when its override is cleared", async () => {
    state.coordinatorModel = null;
    await render();
    // The picker sits under the composer, where the model is read while writing.
    const picker = container.querySelector(".sws-composer [data-coordinator-model]");
    expect(picker?.textContent).toBe("chosen-model");
  });
  it("shows the host's default model when nobody has chosen one", async () => {
    state.coordinatorModel = null;
    state.coordinatorId = null as never;
    state.shells = [];
    Object.assign(state.project, { defaultModelSelection: null });
    state.providers = [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          { slug: "claude-sonnet-5-5", name: "Sonnet 5.5", isCustom: false, isDefault: true },
          { slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, isDefault: false },
        ],
      },
    ];
    await render();
    expect(container.querySelector("[data-coordinator-model]")?.textContent).toBe(
      "claude-opus-5-5",
    );
  });
  it("names a model for a project from before workspace settings and enables it once read", async () => {
    // Shaped like an old project row: no workspace settings and no worker default.
    delete (state.project as { workspaceSettings?: unknown }).workspaceSettings;
    Object.assign(state.project, { defaultModelSelection: null });
    state.coordinatorModel = null;
    state.coordinatorId = null;
    state.shells = [];
    state.providers = [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, isDefault: true }],
      },
    ];
    state.projectReadPending = true;
    await render();
    const picker = () => container.querySelector("[data-coordinator-model]")!;
    expect(picker().textContent).toBe("claude-opus-5-5");
    expect(picker().getAttribute("data-disabled")).toBe("true");
    state.projectReadPending = false;
    await render();
    expect(picker().textContent).toBe("claude-opus-5-5");
    expect(picker().getAttribute("data-disabled")).toBe("false");
  });
  it("names the coordinator thread's model before the worker default", async () => {
    state.coordinatorModel = null;
    state.shells = [
      shell("coord", {
        modelSelection: { instanceId: "claude-native", model: "thread-model" },
      } as never),
    ];
    await render();
    expect(container.querySelector("[data-coordinator-model]")?.textContent).toBe("thread-model");
  });
  it("leaves the project's goal to settings instead of the top of the project", async () => {
    state.goal = "Ship the Atlas importer";
    await render();
    expect(container.querySelector("[data-usage-indicator]")).not.toBeNull();
    expect(container.querySelector("[data-project-pane='coordinator']")).not.toBeNull();
    expect(container.textContent).not.toContain("Ship the Atlas importer");
    expect(container.querySelector("button[aria-label='Edit project goal']")).toBeNull();
    // The operator docs describe the same project view.
    const docs = NodeFS.readFileSync(repoFile("docs/studio/project-orchestration.md"), "utf8");
    expect(docs).not.toMatch(/goal in a strip|strip above the conversation/i);
    expect(docs).toContain("Set or edit it under **Goal** in the project settings");
  });
  it("waits for a picked coordinator model before a worker reply can dispatch", async () => {
    let finish!: (result: unknown) => void;
    state.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await openFirstThread();
    await prompt("Keep this draft");
    let sent!: Promise<void>;
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-coordinator-model]")!.click();
      sent = state.routing!.send("Continue this worker");
    });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>(".sws-send")!.disabled).toBe(true);
    expect(state.send.mock.calls[0]![0].input.workspaceSettings).toEqual({
      expectedRevision: 1,
      coordinatorModelSelection: { instanceId: "codex-native", model: "picked-model" },
    });
    await act(async () => {
      finish({ _tag: "Success" });
      await sent;
    });
    expect(state.send.mock.calls[1]![0].input).toMatchObject({
      projectId: "project",
      sourceThreadId: "worker",
      prompt: "Continue this worker",
    });
    expect(state.refresh).toHaveBeenCalled();
  });
  it("names the provider model on every thread row and groups them by state", async () => {
    state.shells = [
      shell("coord"),
      shell("ask", { hasPendingUserInput: true }),
      shell("worker"),
      shell("done", { settledOverride: "settled" }),
    ];
    await render();
    const groups = [...container.querySelectorAll(".sws-thread-group")].map((group) => [
      group.getAttribute("data-group"),
      group.querySelectorAll(".sws-thread-row").length,
    ]);
    // Finished work stays folded until it is asked for.
    expect(groups).toEqual([
      ["Waiting on you", 1],
      ["Idle", 1],
      ["Resolved", 0],
    ]);
    expect(container.querySelector(".sws-threads-head")?.textContent).toContain(
      "1 thread is waiting on you",
    );
    expect(container.querySelector(".sws-thread-status")?.textContent).toBe("Answer needed");
    const resolved = container.querySelector<HTMLButtonElement>(
      '[data-group="Resolved"] .sws-group-bar',
    )!;
    expect(resolved.getAttribute("aria-expanded")).toBe("false");
    await act(async () => resolved.click());
    expect(resolved.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll(".sws-thread-row [data-model-badge]")).toHaveLength(3);
  });
  it("unfolds Resolved when a thread is resolved from its row", async () => {
    state.shells = [shell("coord"), shell("worker"), shell("done", { settledOverride: "settled" })];
    await render();
    expect(container.querySelector('[data-group="Resolved"] .sws-thread-row')).toBeNull();
    const resolve = container.querySelector<HTMLButtonElement>(
      '[data-group="Idle"] .sws-thread-action',
    )!;
    await act(async () => resolve.click());
    expect(
      container
        .querySelector('[data-group="Resolved"] .sws-group-bar')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });
  it("pages a long group behind Show more", async () => {
    state.shells = [shell("coord"), ...Array.from({ length: 8 }, (_, i) => shell(`w${i}`))];
    await render();
    expect(container.querySelectorAll(".sws-thread-row")).toHaveLength(5);
    await act(async () => container.querySelector<HTMLButtonElement>(".sws-show-more")!.click());
    expect(container.querySelectorAll(".sws-thread-row")).toHaveLength(8);
    await click("Show fewer");
    expect(container.querySelectorAll(".sws-thread-row")).toHaveLength(5);
  });
  it("toggles the overview pane from its button and its shortcut", async () => {
    await render();
    const toggle = () => container.querySelector<HTMLButtonElement>(".sws-overview-toggle")!;
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[aria-label="Project threads"]')).not.toBeNull();
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[aria-label="Project threads"]')).toBeNull();
    expect(container.querySelector('[aria-label="Project coordinator"]')).not.toBeNull();
    await act(async () => toggle().click());
    expect(container.querySelector('[aria-label="Project threads"]')).not.toBeNull();
  });
  it("focuses thread search on slash and leaves an open thread on Escape", async () => {
    await render();
    await press({ key: "/" });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Find a project thread");
    (document.activeElement as HTMLElement).blur();
    await openFirstThread();
    expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
    await press({ key: "Escape" });
    expect(container.querySelector('[data-native-thread="worker"]')).toBeNull();
    expect(container.querySelector('[aria-label="Project threads"]')).not.toBeNull();
  });
  it("keeps thread search behind its button until asked for", async () => {
    await render();
    const find = () => container.querySelector<HTMLInputElement>(".sws-find input");
    const toggle = () =>
      container.querySelector<HTMLButtonElement>('.sws-threads-bar [aria-label="Find a thread"]')!;
    expect(find()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle().click());
    expect(find()).not.toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle().click());
    expect(find()).toBeNull();
  });
  it("sends on Enter and keeps Shift+Enter for a new line", async () => {
    await render();
    await prompt("Build the project");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const key = (init: KeyboardEventInit) =>
      act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
        );
      });
    await key({ shiftKey: true });
    expect(state.send).not.toHaveBeenCalled();
    await key({});
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]![0].input.prompt).toBe("Build the project");
  });
  it("sends on Enter in a narrow desktop window, never on a phone keyboard", async () => {
    // A desktop window squeezed under the phone width still has a hardware keyboard.
    state.phone = true;
    await render();
    await prompt("Build the project");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const enter = () =>
      act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });
    await enter();
    expect(state.send).toHaveBeenCalledTimes(1);
    state.send.mockClear();
    // On a phone the Return key is the on-screen keyboard's new line.
    state.coarse = true;
    await render();
    await prompt("Build the project");
    const phoneInput = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      phoneInput.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("keeps Return for a new line on a landscape phone or tablet keyboard", async () => {
    // Wider than the phone layout, but the keyboard is still on the glass.
    state.coarse = true;
    await render();
    await prompt("Build the project");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("keeps Enter for the input method while it composes, and sends on Cmd/Ctrl+Enter", async () => {
    await render();
    await prompt("こんにちは");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const key = async (init: KeyboardEventInit, keyCode?: number) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
      await act(async () => {
        input.dispatchEvent(event);
      });
      return event;
    };
    expect((await key({ isComposing: true })).defaultPrevented).toBe(false);
    expect((await key({}, 229)).defaultPrevented).toBe(false);
    expect(state.send).not.toHaveBeenCalled();
    await key({ metaKey: true });
    expect(state.send).toHaveBeenCalledTimes(1);
    await prompt("again");
    await key({ ctrlKey: true });
    expect(state.send).toHaveBeenCalledTimes(2);
  });
  it("does not send on Enter while the Send button is disabled", async () => {
    state.connected = false;
    await render();
    await prompt("New work");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    // The key is still the send key, so no stray new line lands in the message.
    expect(event.defaultPrevented).toBe(true);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("waits for the modifier when the person's send shortcut asks for one", async () => {
    state.sendShortcut = "mod-enter";
    await render();
    await prompt("Build the project");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const key = (init: KeyboardEventInit) =>
      act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
        );
      });
    await key({});
    expect(state.send).not.toHaveBeenCalled();
    await key({ metaKey: true });
    await key({ ctrlKey: true });
    expect(state.send).toHaveBeenCalledTimes(1);
  });
  it("starts a phone on the coordinator and leaves the wide layout's choice alone", async () => {
    state.phone = true;
    await render();
    expect(container.querySelector('[aria-label="Project threads"]')).toBeNull();
    expect(container.querySelector("#project-prompt")).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".sws-overview-toggle")!.click(),
    );
    expect(container.querySelector('[aria-label="Project threads"]')).not.toBeNull();
    expect(localStorage.getItem("studio:project-overview-open:v1")).toBeNull();
  });
  it("returns the keyboard to the Find button when Escape closes an empty search", async () => {
    await render();
    await press({ key: "/" });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const input = container.querySelector<HTMLInputElement>(".sws-find input")!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector(".sws-find input")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Find a thread");
  });
  it("reaches the Threads pane with F6 while its search is tucked away", async () => {
    await render();
    container.querySelector<HTMLTextAreaElement>("#project-prompt")!.focus();
    const bar = container.querySelector<HTMLElement>(".sws-group-bar")!;
    // jsdom lays nothing out; say the pane is on screen.
    Object.defineProperty(bar, "offsetParent", { configurable: true, get: () => document.body });
    bar.getBoundingClientRect = () => ({ right: 10 }) as DOMRect;
    await press({ key: "F6" });
    expect(document.activeElement).toBe(bar);
  });
  it("hands focus to the Overview button when the pane is closed from inside", async () => {
    await render();
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Hide overview"]')!;
    close.focus();
    await act(async () => close.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(container.querySelector('[aria-label="Project threads"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".sws-overview-toggle"));
  });
  it("shows a thread's pull request beside its age", async () => {
    state.shells = [
      shell("coord"),
      shell("worker", {
        pullRequests: [
          {
            host: "github.com",
            repository: "acme/atlas",
            number: 21,
            url: "https://github.com/acme/atlas/pull/21",
            source: "created",
            linkedAt: "2026-10-01T00:00:00.000Z",
            snapshot: null,
            stack: null,
          },
        ] as unknown as EnvironmentThreadShell["pullRequests"],
      }),
    ];
    await render();
    const pill = container.querySelector(".sws-thread-pr");
    expect(pill?.textContent).toContain("#21");
    expect(pill?.getAttribute("data-state")).toBe("open");
  });
  it("offers no control that starts a thread: the coordinator starts them", async () => {
    await render();
    expect(container.querySelector('[aria-label="New thread in this project"]')).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        /new thread/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`),
      ),
    ).toBe(false);
    await openFirstThread();
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        /new thread/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`),
      ),
    ).toBe(false);
  });
  it("keeps what was typed in a thread on record inside that thread", async () => {
    const wrap = (id: string, text: string) =>
      `User follow-up from selected worker ${id}. Review that thread and decide whether to reuse it or route elsewhere.\n\n${text}`;
    state.shells.push(shell("second", { title: "Second worker" }));
    state.messages = [
      {
        id: "coordinator-send:project:one",
        role: "user",
        createdBy: "user",
        senderThreadId: "worker",
        text: wrap("worker", "Also cover the away fixtures."),
        streaming: false,
        attachments: [],
      },
      {
        id: "answer-one",
        role: "assistant",
        createdBy: "agent",
        text: "Sent to [Thread worker](studio://thread/worker).",
        streaming: false,
        attachments: [],
      },
      {
        id: "coordinator-send:project:two",
        role: "user",
        createdBy: "user",
        senderThreadId: "second",
        text: wrap("second", "Belongs to the other thread."),
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-thread-id="worker"] .sws-thread-open')!
        .click(),
    );
    const record = container.querySelector<HTMLDetailsElement>("details.project-routed")!;
    expect(record.querySelector("summary")?.textContent).toBe(
      "1 message you sent from this thread",
    );
    expect(record.textContent).toContain("Also cover the away fixtures.");
    expect(record.textContent).toContain("Coordinator: Sent to Thread worker.");
    expect(record.textContent).not.toContain("Belongs to the other thread.");
    expect(record.textContent).not.toContain("User follow-up from selected worker");
    // The same message stays on the coordinator conversation, attributed to its thread.
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    expect(conversation.textContent).toContain("Also cover the away fixtures.");
    expect(conversation.textContent).toContain("From Thread worker");
    // The coordinator is the main conversation: the panel lets go of the thread for it.
    await click("Show in the coordinator chat");
    expect(container.querySelector('[data-native-thread="coord"]')).toBeNull();
    expect(container.querySelector('[data-native-thread="worker"]')).toBeNull();
    expect(container.querySelector("details.project-routed")).toBeNull();
  });
  it("shows a worker's long report as a card and folds the coordinator's relay of it", async () => {
    const long = Array.from({ length: 20 }, (_, i) => `- Finding ${i + 1}`).join("\n");
    const message = (id: string, role: string, createdBy: string, extra: object = {}) => ({
      id,
      role,
      createdBy,
      text: long,
      streaming: false,
      attachments: [],
      ...extra,
    });
    state.messages = [
      message("plan", "assistant", "agent"),
      // A delegate_task completion wakes the coordinator; people see "reported back".
      message("wake", "user", "system", {
        delegatedCompletion: { taskIds: ["node:delegated-task:a"] },
      }),
      message("relay", "assistant", "agent"),
      message("worker-report", "user", "agent", { senderThreadId: "worker" }),
    ];
    state.threadReports = {
      workspaceRoot: "/repo",
      specweave: true,
      increment: { id: "0973-budget", path: ".specweave/increments/0973-budget" },
      folder: ".specweave/increments/0973-budget/reports",
      reports: [],
    };
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    expect(conversation.textContent).toContain("reported back.");
    const articles = [...conversation.querySelectorAll("article")];
    const byAuthor = (author: string) =>
      articles.filter((article) => article.querySelector("h3")?.textContent === author);
    // The coordinator's reply before any worker reported back stays whole.
    expect(articles[0]!.querySelector('[data-report-collapsed="true"]')).toBeNull();
    expect(articles[0]!.querySelector("[data-report-artifact]")).toBeNull();

    // The worker's report is a card naming its increment, not a clamped wall of text.
    const report = byAuthor("Message from a worker")[0]!;
    expect(report.querySelector('[data-report-artifact="true"]')).not.toBeNull();
    expect(report.querySelector("[data-report-increment]")?.textContent).toBe("0973-budget");
    expect(report.textContent).not.toContain("- Finding 20");
    const save = [...report.querySelectorAll("button")].find(
      (b) => b.textContent === "Save to increment",
    )!;
    state.send.mockResolvedValueOnce({ _tag: "Success", value: state.threadReports });
    await act(async () => save.click());
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ threadId: "worker", text: long }),
      }),
    );
    expect(state.refresh).toHaveBeenCalled();

    // The coordinator's relay folds inline; expanded it is bounded and folds again.
    const relay = byAuthor("Coordinator").at(-1)!;
    expect(relay.querySelector('[data-report-collapsed="true"]')).not.toBeNull();
    const toggle = [...relay.querySelectorAll("button")].find(
      (b) => b.textContent === "Show full message",
    )!;
    await act(async () => toggle.click());
    expect(relay.querySelector('[data-report-collapsed="true"]')).toBeNull();
    expect(relay.querySelector('[data-report-expanded="true"]')).not.toBeNull();
    expect(toggle.textContent).toBe("Show less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle.click());
    expect(relay.querySelector('[data-report-collapsed="true"]')).not.toBeNull();
  });
  it("announces a thread started this turn with a card and links one that existed", async () => {
    state.shells.push(
      shell("fresh", { title: "Skills consolidation", createdAt: "2026-10-11T05:00:03Z" }),
    );
    state.messages = [
      {
        id: "ask",
        role: "user",
        createdBy: "user",
        text: "Consolidate the skills.",
        createdAt: "2026-10-11T05:00:00Z",
        streaming: false,
        attachments: [],
      },
      {
        id: "ack",
        role: "assistant",
        createdBy: "agent",
        text: "Started [Skills consolidation](studio://thread/fresh), next to [Thread worker](studio://thread/worker).",
        createdAt: "2026-10-11T05:00:04Z",
        updatedAt: "2026-10-11T05:00:05Z",
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    const cards = conversation.querySelectorAll<HTMLElement>(".sws-thread-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Skills consolidation");
    expect(cards[0]!.getAttribute("aria-label")).toBe("Thread Skills consolidation, Idle");
    // Both threads the sentence names are chips with a status dot.
    const chips = conversation.querySelectorAll<HTMLButtonElement>(".sws-thread-link");
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      "Skills consolidation",
      "Thread worker",
    ]);
    expect(chips[0]!.classList.contains("sws-thread-mention")).toBe(true);
    expect(chips[1]!.querySelector(".sws-dot")?.getAttribute("data-tone")).toBe("idle");
    expect(chips[1]!.getAttribute("aria-label")).toBe("Open thread Thread worker, Idle");
    // Without a branch or a pull request, the card only offers to view the thread.
    const actions = [...cards[0]!.querySelectorAll("button")];
    expect(actions.map((b) => b.textContent)).toEqual(["View thread"]);
    await act(async () => actions[0]!.click());
    expect(container.querySelector('[data-native-thread="fresh"]')).not.toBeNull();
    await act(async () => chips[1]!.click());
    expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
    await act(async () => chips[0]!.click());
    expect(container.querySelector('[data-native-thread="fresh"]')).not.toBeNull();
  });
  it("opens a delegated worker whose ID contains %3A from every link the coordinator writes", async () => {
    const id = "thread:delegated-task:command%3Amcp%3Ad859%3Adelegate-task%3Acoord-format-alpha";
    state.shells.push(
      shell(id, {
        title: "Coordinator formatting and Alpha label",
        createdAt: "2026-10-09T00:00:00Z",
      }),
    );
    state.messages = [
      {
        id: "ack",
        role: "assistant",
        createdBy: "agent",
        text: `Raw [Coordinator formatting and Alpha label](studio://thread/${id}), encoded [Formatting](studio://thread/${encodeURIComponent(id)}), and [Gone](studio://thread/not-here).`,
        createdAt: "2026-10-11T05:00:04Z",
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    const chips = conversation.querySelectorAll<HTMLButtonElement>(`[data-thread-chip="${id}"]`);
    expect(chips).toHaveLength(2);
    // The chip shows the live title, whatever label the message gave it.
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      "Coordinator formatting and Alpha label",
      "Coordinator formatting and Alpha label",
    ]);
    expect(chips[1]!.getAttribute("data-markdown-copy")).toBe(
      `[Coordinator formatting and Alpha label](studio://thread/${encodeURIComponent(id)})`,
    );
    // A link to a thread this project does not have goes to the standard chip.
    expect(conversation.querySelector('[data-fallback-thread-link="not-here"]')?.textContent).toBe(
      "Gone",
    );
    await act(async () => chips[1]!.click());
    expect(container.querySelector(`[data-native-thread="${id}"]`)).not.toBeNull();
  });
  it("opens a worker only for its own ID, and reads a coordinator link as its label", async () => {
    state.shells.push(
      shell("retry", { title: "Retry me", createdAt: "2026-10-09T00:00:00Z" }),
      shell("first", { title: "Retry me", deletedAt: "2026-10-10T00:00:00Z" }),
      shell("elsewhere", { title: "Retry me", projectId: "other" as never }),
    );
    state.messages = [
      {
        id: "ack",
        role: "assistant",
        createdBy: "agent",
        text: "Deleted [Retry me](studio://thread/first), other [Retry me](studio://thread/elsewhere), me [Coordinator](studio://thread/coord).",
        createdAt: "2026-10-11T05:00:04Z",
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    expect(conversation.querySelector('[data-thread-chip="retry"]')).toBeNull();
    expect(conversation.querySelector('[data-fallback-thread-link="first"]')).not.toBeNull();
    expect(conversation.querySelector('[data-fallback-thread-link="elsewhere"]')).not.toBeNull();
    expect(conversation.querySelector('[data-fallback-thread-link="coord"]')).toBeNull();
    expect(conversation.textContent).toContain("me Coordinator.");
  });
  it("shows no record in a thread nothing was typed in", async () => {
    await render();
    await openFirstThread();
    expect(container.querySelector("details.project-routed")).toBeNull();
  });
  it("does not launch on mount and scopes worker cards to this host/project", async () => {
    await render();
    expect(state.send).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Thread worker");
    expect(container.textContent).not.toContain("Thread foreign");
  });
  it("retains the coordinator while a selected worker sends its exact source ID", async () => {
    await render();
    await openFirstThread();
    expect(container.querySelector('[aria-label="Project coordinator"]')).not.toBeNull();
    expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
    await click("Reply in selected thread");
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]![0]).toMatchObject({
      environmentId: "host",
      input: { projectId: "project", sourceThreadId: "worker", prompt: "Continue this worker" },
    });
  });
  it("opens existing workers and routes a first reply before coordinator creation", async () => {
    state.coordinatorId = null;
    state.shells = state.shells.filter((t) => t.id !== "coord");
    await render();
    await openFirstThread();
    await click("Reply in selected thread");
    expect(state.send.mock.calls[0]![0].input.sourceThreadId).toBe("worker");
  });
  it("preserves a rejected draft and retries an uncertain result with the same identity", async () => {
    state.send.mockResolvedValueOnce({
      _tag: "Failure",
      error: new Error("Host disconnected before confirmation"),
    });
    await render();
    await prompt("Build the project");
    await click("Send");
    const id = state.send.mock.calls[0]![0].input.commandId;
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "Build the project",
    );
    expect(container.textContent).toContain("Host disconnected before confirmation");
    await click("Send");
    expect(state.send.mock.calls[1]![0].input.commandId).toBe(id);
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("");
  });
  it("reuses an uncertain send identity after the project is reloaded", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Response lost") });
    await render();
    await prompt("Retry after reload");
    await click("Send");
    const requestId = state.send.mock.calls[0]![0].input.commandId;
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    await prompt("Retry after reload");
    await click("Send");
    expect(state.send.mock.calls[1]![0].input.commandId).toBe(requestId);
  });
  it("continues an existing coordinator when project defaults have been cleared", async () => {
    state.coordinatorModel = null;
    Object.assign(state.project, { defaultModelSelection: null });
    await render();
    await prompt("Continue existing coordinator");
    await click("Send");
    expect(state.send).toHaveBeenCalledOnce();
  });
  it("blocks admission when the selected host is disconnected", async () => {
    state.connected = false;
    await render();
    await prompt("New work");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send to coordinator"]')!.disabled,
    ).toBe(true);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("lays the panel out as Threads, Library, PRs and Scheduled tabs", async () => {
    state.shells = [
      shell("coord"),
      shell("worker", {
        pullRequests: [
          {
            host: "github.com",
            repository: "acme/atlas",
            number: 21,
            url: "https://github.com/acme/atlas/pull/21",
            source: "created",
            linkedAt: "2026-10-01T00:00:00.000Z",
            snapshot: null,
            stack: null,
          },
        ] as unknown as EnvironmentThreadShell["pullRequests"],
      }),
    ];
    await render();
    // Each pane draws its own bar, so the tabs are looked up after every switch.
    const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs().map((tab) => tab.querySelector(".sws-pane-tab-label")?.textContent)).toEqual([
      "Threads",
      "Library",
      "PRs",
      "Scheduled",
    ]);
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[2]!.textContent).toContain("1");
    await act(async () => tabs()[2]!.click());
    expect(container.querySelector("#sws-pane-prs")?.textContent).toContain("acme/atlas #21");
    expect(localStorage.getItem("studio:project-pane-tab:v1")).toContain("prs");
    // Arrow keys move along the tabs, as a tablist does.
    await act(async () =>
      tabs()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
    );
    expect(container.textContent).toContain("Library pane");
  });
  it("widens the panel over the coordinator and back", async () => {
    await render();
    const expand = () =>
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Expand panel"], [aria-label="Restore panel"]',
      )!;
    const columns = () => container.querySelector(".sws-columns")!;
    await act(async () => expand().click());
    expect(columns().getAttribute("data-expanded")).toBe("true");
    expect(expand().getAttribute("aria-label")).toBe("Restore panel");
    await act(async () => expand().click());
    expect(columns().getAttribute("data-expanded")).toBeNull();
  });
  it("gives an open thread a Resolve button and an actions menu", async () => {
    await render();
    await openFirstThread();
    const resolve = container.querySelector<HTMLButtonElement>('[aria-label="Resolve thread"]');
    expect(resolve).not.toBeNull();
    await act(async () => resolve!.click());
    expect(state.settle).toHaveBeenCalledWith({ environmentId: "host", threadId: "worker" });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Thread actions"]')!.click(),
    );
    expect(state.openMenu).toHaveBeenCalledTimes(1);
  });
  it("resolves through the native thread API without starting a provider", async () => {
    await render();
    await click("Resolve");
    expect(state.settle).toHaveBeenCalledWith({ environmentId: "host", threadId: "worker" });
    expect(state.send).not.toHaveBeenCalled();
  });
  it("shares one title row: the top bar over the coordinator, the panel's header beside it", async () => {
    await render();
    // Nothing spans the window above the two columns.
    expect(container.querySelector(".sws-project > header")).toBeNull();
    const coordinator = container.querySelector('[aria-label="Project coordinator"]')!;
    const topBar = coordinator.firstElementChild!;
    expect(topBar.tagName).toBe("HEADER");
    expect(topBar.querySelector(".sws-overview-toggle")).not.toBeNull();
    const pane = container.querySelector("#project-threads-pane")!;
    expect(pane.querySelectorAll(".sws-pane-head")).toHaveLength(1);
    expect(pane.firstElementChild!.classList.contains("sws-pane-head")).toBe(true);
    expect(pane.firstElementChild!.querySelector('[role="tablist"]')).not.toBeNull();
  });
  it("turns the panel's header row into the open thread's header, not a second row", async () => {
    await render();
    await openFirstThread();
    const pane = container.querySelector("#project-threads-pane")!;
    const rows = pane.querySelectorAll(".sws-pane-head");
    expect(rows).toHaveLength(1);
    expect(pane.firstElementChild).toBe(rows[0]);
    expect(rows[0]!.classList.contains("sws-thread-head")).toBe(true);
    expect(pane.querySelector('[role="tablist"]')).toBeNull();
    const back = rows[0]!.querySelector<HTMLButtonElement>(
      '[aria-label="Back to project threads"]',
    )!;
    expect(back.textContent).toBe("Threads");
    expect(rows[0]!.querySelector("h2")?.textContent).toBe("Thread worker");
    await act(async () => back.click());
    expect(container.querySelector('[data-native-thread="worker"]')).toBeNull();
    expect(pane.querySelector('[role="tablist"]')).not.toBeNull();
  });
});

it("binds worker attachment identity to retries and sends pending refs to the coordinator", async () => {
  state.attachments = [
    {
      type: "file",
      id: "pending-00000000-0000-4000-8000-000000000001-txt",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
    },
  ];
  state.send.mockResolvedValue({ _tag: "Failure", error: new Error("Acknowledgement lost") });
  await render();
  await openFirstThread();
  await click("Reply in selected thread");
  await click("Reply in selected thread");
  const first = state.send.mock.calls[0]![0].input;
  expect(first.attachments).toEqual(state.attachments);
  expect(first.sourceThreadId).toBe("worker");
  expect(state.send.mock.calls[1]![0].input.commandId).toBe(first.commandId);
  state.attachments = [
    { ...state.attachments[0]!, id: "pending-00000000-0000-4000-8000-000000000002-txt" },
  ];
  await click("Reply in selected thread");
  expect(state.send.mock.calls[2]![0].input.commandId).not.toBe(first.commandId);
});

it("shows the original worker follow-up with clickable provenance and preserved attachments", async () => {
  const workerId = "a3111111-2222-4333-8444-555555555555";
  state.shells.push(shell(workerId, { title: "Calendar improvements" }));
  const original = "Keep the next match visible.\n\n**Preserve this formatting.**";
  const wrapped = `User follow-up from selected worker ${workerId}. Review that thread and decide whether to reuse it or route elsewhere.\n\n${original}`;
  state.messages = [
    {
      id: "coordinator-send:project:request:attachment-fingerprint",
      role: "user",
      createdBy: "user",
      senderThreadId: workerId,
      text: wrapped,
      streaming: false,
      attachments: [
        { type: "file", id: "file-1", name: "calendar.txt", mimeType: "text/plain", sizeBytes: 3 },
      ],
    },
  ];
  await render();
  const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
  expect(conversation.textContent).toContain(original);
  expect(conversation.textContent).not.toContain("User follow-up from selected worker");
  expect(conversation.textContent).not.toContain(workerId);
  expect(conversation.textContent).toContain("calendar.txt");
  const header = conversation.querySelector<HTMLElement>(".project-message-source")!;
  expect(header.textContent).toBe("From Calendar improvements");
  const source = header.querySelector<HTMLButtonElement>(`[data-thread-chip="${workerId}"]`)!;
  expect(source.getAttribute("aria-label")).toMatch(/^Open thread Calendar improvements, /);
  expect(source.querySelector(".sws-dot")).not.toBeNull();
  await act(async () => source.click());
  expect(container.querySelector(`[data-native-thread="${workerId}"]`)).not.toBeNull();
  expect(state.messages[0]?.text).toBe(wrapped);
  expect(state.send).not.toHaveBeenCalled();
});

it("keeps agent-origin messages and their sending-thread control unchanged", async () => {
  const text =
    "User follow-up from selected worker worker. Review that thread and decide whether to reuse it or route elsewhere.\n\nAgent update";
  state.messages = [
    {
      id: "coordinator-send:project:agent",
      role: "user",
      createdBy: "agent",
      senderThreadId: "worker",
      text,
      streaming: false,
      attachments: [],
    },
  ];
  await render();
  const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
  expect(conversation.textContent).toContain("Message from a worker");
  expect(conversation.textContent).toContain(text);
  const sender = conversation.querySelector<HTMLButtonElement>('[data-thread-chip="worker"]')!;
  expect(sender.closest(".project-message-source")!.textContent).toMatch(/^Sent by /);
  expect(sender.querySelector(".sws-dot")).not.toBeNull();
  await act(async () => sender.click());
  expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
});

it.each([
  { label: "ordinary typed message", id: "ordinary-message", senderThreadId: "worker" },
  { label: "foreign sender", id: "coordinator-send:project:request", senderThreadId: "foreign" },
])("preserves a literal wrapper from an $label", async ({ id, senderThreadId }) => {
  const text = `User follow-up from selected worker ${senderThreadId}. Review that thread and decide whether to reuse it or route elsewhere.\n\nKeep this literal example.`;
  state.messages = [
    {
      id,
      role: "user",
      createdBy: "user",
      senderThreadId,
      text,
      streaming: false,
      attachments: [],
    },
  ];
  await render();
  const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
  expect(conversation.textContent).toContain(text);
  expect(conversation.querySelector('button[aria-label^="Open source thread"]')).toBeNull();
  expect(conversation.querySelector(".project-message-source")?.textContent ?? "").not.toMatch(
    /^From /,
  );
  expect(state.messages[0]?.text).toBe(text);
  expect(state.send).not.toHaveBeenCalled();
});

describe("a coordinator turn that failed", () => {
  const failedCoordinator = (lastError: string | null) =>
    shell("coord", {
      latestRun: { runId: "run-1", status: "failed" },
      runtime: { lastError },
    } as unknown as Partial<EnvironmentThreadShell>);
  beforeEach(() => {
    state.messages = [
      {
        id: "m1",
        role: "user",
        createdBy: "user",
        runId: "run-1",
        text: "Reply with OK",
        streaming: false,
        attachments: [],
      },
    ];
  });

  it("says so in the project conversation, with the host's reason", async () => {
    state.shells = [
      failedCoordinator("Provider session failed to open: no remaining permitted usage."),
      shell("worker"),
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    const alert = conversation.querySelector("[data-coordinator-failure][role='alert']");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("The coordinator did not answer.");
    expect(alert!.textContent).toContain("no remaining permitted usage");
    // Review keeps the project open and mounts native controls in its main pane.
    const open = alert!.querySelector("button")!;
    expect(open.textContent).toBe("Review coordinator");
    await act(async () => open.click());
    expect(
      container
        .querySelector('[data-native-thread="coord"]')
        ?.closest('[data-project-pane="coordinator"]'),
    ).not.toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("still says the turn failed when the host gave no reason", async () => {
    state.shells = [failedCoordinator(null), shell("worker")];
    await render();
    expect(container.querySelector("[data-coordinator-failure]")!.textContent).toContain(
      "The coordinator could not start a turn.",
    );
  });

  it("shows nothing once the latest turn did not fail", async () => {
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-2", status: "completed" },
        runtime: { lastError: null },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    await render();
    expect(container.querySelector("[data-coordinator-failure]")).toBeNull();
  });
});

describe("starter tasks in a project with no threads", () => {
  const found = [
    {
      id: "changes",
      topic: "changes" as const,
      origin: "repository" as const,
      title: "Review 2 uncommitted changes",
      detail: "Work in this checkout that is not committed yet.",
      prompt: 'Start a thread titled "Review uncommitted changes". Read them.',
    },
    {
      id: "explore",
      topic: "explore" as const,
      origin: "common" as const,
      title: "Explore the codebase",
      detail: "Map the main parts.",
      prompt: 'Start a thread titled "Explore the codebase". Map this repository.',
    },
  ];
  const cards = (layout: "cards" | "list") => [
    ...container.querySelectorAll<HTMLButtonElement>(
      `.sws-starters[data-layout="${layout}"] button.sws-starter`,
    ),
  ];
  beforeEach(() => {
    state.shells = [shell("coord")];
    state.starters = { suggestions: found, hasWorkspace: true };
  });

  it("greets with three ways in and offers what the host found in the Threads pane", async () => {
    await render();
    // The coordinator's empty conversation reads like Claude's project home.
    const welcome = container.querySelector(".sws-coordinator-greeting")!;
    expect(welcome.querySelector(".sws-greeting")!.textContent).toContain(
      "Here are a few ways to begin.",
    );
    expect([...welcome.querySelectorAll(".sws-quick-start")].map((b) => b.textContent)).toEqual([
      "Set up from recent work",
      "Connect tools",
      "Make a plan",
    ]);
    // The host's project-specific ideas live in the Threads pane, not beside the greeting.
    expect(welcome.querySelector(".sws-starters")).toBeNull();
    expect(cards("list").map((card) => card.querySelector("strong")!.textContent)).toEqual([
      "Review 2 uncommitted changes",
      "Explore the codebase",
    ]);
    expect(cards("list")[0]!.textContent).toContain("From the repository");
    expect(cards("list")[1]!.textContent).toContain("Good first step");
    const pane = container.querySelector('[aria-label="Project threads"]')!;
    expect(pane.querySelector(".sws-threads-head p")!.textContent).toBe(
      "No threads yet. Pick a first task, or ask the coordinator for one.",
    );
    // No empty groups under the ideas: there is nothing to group yet.
    expect(pane.querySelector(".sws-group-bar")).toBeNull();
  });

  it("sends the chosen task to the coordinator, which starts the thread", async () => {
    await render();
    await act(async () => cards("list")[0]!.click());
    expect(state.send).toHaveBeenCalledOnce();
    const input = state.send.mock.calls[0]![0].input;
    expect(input.prompt).toBe(found[0]!.prompt);
    expect(input.projectId).toBe("project");
    expect(input.sourceThreadId).toBeUndefined();
    // Sent once; the other idea is still there to take.
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(cards("list")[0]!.textContent).toContain("Sent to the coordinator.");
    expect(cards("list")[1]!.disabled).toBe(false);
    await act(async () => cards("list")[1]!.click());
    expect(state.send.mock.calls[1]![0].input.prompt).toBe(found[1]!.prompt);
  });

  it("keeps the task on offer and says why when it was not delivered", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Host went away") });
    await render();
    await act(async () => cards("list")[0]!.click());
    expect(alertText()).toBe("Host went away");
    expect(cards("list")[0]!.disabled).toBe(false);
    await act(async () => cards("list")[0]!.click());
    // The retry is the same request, so the coordinator cannot be asked twice.
    expect(state.send.mock.calls[1]![0].input.commandId).toBe(
      state.send.mock.calls[0]![0].input.commandId,
    );
    expect(cards("list")[0]!.disabled).toBe(true);
  });

  it("keeps a task marked sent after a reload, from the coordinator thread", async () => {
    state.messages = [
      {
        id: "m1",
        role: "user",
        createdBy: "user",
        runId: "run-1",
        text: found[0]!.prompt,
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    // The greeting gives way to the conversation; the Threads pane keeps the list.
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(cards("list")[0]!.textContent).toContain("Sent to the coordinator.");
    expect(cards("list")[1]!.disabled).toBe(false);
  });

  it("offers the task again when the coordinator's turn for it failed", async () => {
    await render();
    await act(async () => cards("list")[0]!.click());
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(container.textContent).toContain("Queued for the coordinator.");
    // The host echoes the message, then its run fails to open a provider session.
    state.messages = [
      {
        id: "m1",
        role: "user",
        createdBy: "user",
        runId: "run-1",
        text: found[0]!.prompt,
        streaming: false,
        attachments: [],
      },
    ];
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-1", status: "failed" },
        runtime: { lastError: "You have reached your weekly usage limit." },
      } as unknown as Partial<EnvironmentThreadShell>),
    ];
    await render();
    expect(cards("list")[0]!.disabled).toBe(false);
    expect(cards("list")[0]!.textContent).not.toContain("Sent to the coordinator.");
    expect(container.textContent).not.toContain("Queued for the coordinator.");
    await act(async () => cards("list")[0]!.click());
    expect(state.send).toHaveBeenCalledTimes(2);
  });

  it("offers nothing, and asks the host nothing, once the project has a thread", async () => {
    state.shells = [shell("coord"), shell("worker")];
    await render();
    expect(container.querySelector(".sws-starters")).toBeNull();
    expect(state.starterReads).toBe(0);
    expect(container.querySelector(".sws-group-bar")).not.toBeNull();
  });

  it("greets nobody while the workspace read is pending, so a conversation is never covered", async () => {
    // The project shell already names a coordinator; its history arrives with the read.
    state.projectReadPending = true;
    Object.assign(state.project, { workspaceSettings: { coordinatorThreadId: "coord" } });
    try {
      await render();
      expect(container.querySelector(".sws-coordinator-greeting")).toBeNull();
      expect(container.querySelector(".sws-quick-start")).toBeNull();
    } finally {
      delete (state.project as { workspaceSettings?: unknown }).workspaceSettings;
    }
  });

  it("greets a project known to have no coordinator yet", async () => {
    state.coordinatorId = null;
    state.shells = [];
    await render();
    expect(container.querySelector(".sws-greeting")!.textContent).toBe(
      "Hi there,Excited to get started on Atlas. Here are a few ways to begin.",
    );
  });

  it("keeps the ideas in the Threads pane after the coordinator has been spoken to", async () => {
    state.messages = [
      {
        id: "m1",
        text: "Hello",
        role: "user",
        createdBy: "user",
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    expect(container.querySelector(".sws-coordinator-greeting")).toBeNull();
    expect(cards("list")).toHaveLength(2);
  });

  it("holds the space while the host is reading the project", async () => {
    state.starters = null;
    state.startersPending = true;
    await render();
    const section = container.querySelector('.sws-starters[data-layout="list"]')!;
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(section.querySelectorAll("button")).toHaveLength(0);
    expect(section.querySelectorAll(".sws-starter-pending").length).toBeGreaterThan(0);
  });

  it("falls back to the general steps and the goal when the host cannot answer", async () => {
    state.starters = null;
    state.startersError = "Unknown method";
    state.goal = "Ship the importer";
    await render();
    expect(cards("list").map((card) => card.querySelector("strong")!.textContent)).toEqual([
      "Plan the first steps toward the goal",
      "Explore the codebase",
      "Write project memory",
      "Set up a routine",
    ]);
    expect(cards("list")[0]!.textContent).toContain("Ship the importer");
  });

  it("shows the ideas but sends none while the host is disconnected", async () => {
    state.connected = false;
    await render();
    expect(cards("list").every((card) => card.disabled)).toBe(true);
    expect(container.querySelector(".sws-starter-note")!.textContent).not.toBe("");
    await act(async () => cards("list")[0]!.click());
    expect(state.send).not.toHaveBeenCalled();
  });

  it("asks for a coordinator model before a first task can start one", async () => {
    // A brand new project: no coordinator thread yet, and nothing chosen to run one on.
    state.coordinatorId = null;
    state.coordinatorModel = null;
    state.shells = [];
    Object.assign(state.project, { defaultModelSelection: null });
    await render();
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(container.querySelector(".sws-starter-note")!.textContent).toBe(
      "Choose a coordinator model to start one of these.",
    );
  });

  it("says why Enter did not send when no coordinator model is chosen", async () => {
    state.coordinatorId = null;
    state.coordinatorModel = null;
    state.shells = [];
    Object.assign(state.project, { defaultModelSelection: null });
    await render();
    await prompt("Build the project");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(state.send).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Choose and save a coordinator or worker model in project settings first.",
    );
  });

  it("does not ask for a coordinator model while the host's models load", async () => {
    state.coordinatorId = null;
    state.coordinatorModel = null;
    state.shells = [];
    state.serverConfigPending = true;
    Object.assign(state.project, { defaultModelSelection: null });
    await render();
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(container.querySelector(".sws-starter-note")!.textContent).toBe(
      "Models are still loading from this host.",
    );
    expect(container.textContent).not.toContain("Choose a coordinator model");
  });

  it("does not ask for a coordinator model while the host checks its providers", async () => {
    state.coordinatorId = null;
    state.coordinatorModel = null;
    state.shells = [];
    // Right after a restart the host sends its config with a placeholder Claude.
    state.providers = [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        models: [],
      },
    ];
    Object.assign(state.project, { defaultModelSelection: null });
    await render();
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(container.querySelector(".sws-starter-note")!.textContent).toBe(
      "Models are still loading from this host.",
    );
    expect(container.textContent).not.toContain("Choose a coordinator model");
  });

  it("returns a phone to the coordinator after a task is picked in the Threads pane", async () => {
    state.phone = true;
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".sws-overview-toggle")!.click(),
    );
    await act(async () => cards("list")[0]!.click());
    expect(state.send).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Project threads"]')).toBeNull();
  });

  it("reaches the first idea with F6 when there are no thread groups", async () => {
    await render();
    container.querySelector<HTMLTextAreaElement>("#project-prompt")!.focus();
    const first = cards("list")[0]!;
    Object.defineProperty(first, "offsetParent", { configurable: true, get: () => document.body });
    first.getBoundingClientRect = () => ({ right: 10 }) as DOMRect;
    await press({ key: "F6" });
    expect(document.activeElement).toBe(first);
  });
});

describe("a project that is not loaded", () => {
  it("waits for the hosts before calling the project unavailable", async () => {
    state.projectLoaded = false;
    state.shellsBootstrapped = false;
    await render();
    expect(container.textContent).not.toContain("Project unavailable");
    expect(container.textContent).toContain("Loading project");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    // The saved hosts can settle before this computer's own host is known.
    state.shellsBootstrapped = true;
    state.primaryRegistered = false;
    await render();
    expect(container.textContent).not.toContain("Project unavailable");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    state.projectLoaded = true;
    state.primaryRegistered = true;
    await render();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector("#project-prompt")).not.toBeNull();
  });

  it("opens a project linked by its machine and path after the repository key replaced it", async () => {
    const moved = vi.fn();
    await act(async () =>
      root.render(<ProjectWorkspace projectKey="host:/scratch/atlas" onProjectKeyMoved={moved} />),
    );
    expect(container.textContent).not.toContain("Project unavailable");
    expect(container.querySelector("#project-prompt")).not.toBeNull();
    expect(moved).toHaveBeenCalledWith("atlas");
  });

  it("says so once every host has answered without it", async () => {
    state.projectLoaded = false;
    await render();
    expect(container.textContent).toContain("Project unavailable");
  });
});

describe("open in new window", () => {
  // The action lives in the project's "More" menu, which renders outside the container.
  const item = async () => {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '.project-header-actions [aria-label="More project actions"]',
        )!
        .click(),
    );
    return (
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
        element.textContent?.includes("Open in new window"),
      ) ?? null
    );
  };

  it("opens this project in its own desktop window", async () => {
    const openProjectWindow = vi.fn(async () => undefined);
    window.desktopBridge = { openProjectWindow } as unknown as NonNullable<
      typeof window.desktopBridge
    >;
    await render();
    const open = await item();
    expect(open).not.toBeNull();
    await act(async () => open!.click());
    expect(openProjectWindow).toHaveBeenCalledExactlyOnceWith({
      projectKey: "atlas",
      title: "Atlas",
    });
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("offers nothing inside the project's own window", async () => {
    window.desktopBridge = {
      openProjectWindow: vi.fn(),
      getWindowProjectKey: () => "atlas",
    } as unknown as NonNullable<typeof window.desktopBridge>;
    await render();
    expect(await item()).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
  });

  it("still offers it for another project viewed in a project window", async () => {
    window.desktopBridge = {
      openProjectWindow: vi.fn(),
      getWindowProjectKey: () => "orbit",
    } as unknown as NonNullable<typeof window.desktopBridge>;
    await render();
    expect(await item()).not.toBeNull();
  });

  it("offers nothing in the browser", async () => {
    await render();
    expect(await item()).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
  });

  it("offers nothing on a desktop build without project windows", async () => {
    window.desktopBridge = {} as unknown as NonNullable<typeof window.desktopBridge>;
    await render();
    expect(await item()).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
  });
});

describe("coordinator progress", () => {
  it("replaces Queued with what the coordinator is doing, then clears when its turn ends", async () => {
    await render();
    await prompt("Plan the finance feature");
    await click("Send");
    expect(container.textContent).toContain("Queued for the coordinator.");
    // The host accepted the message and queued the coordinator's turn.
    const requestedAt = new Date(Date.now() - 3_000).toISOString();
    state.runs = [{ id: "run-1", ordinal: 1, status: "queued", requestedAt }];
    await render();
    const line = () => container.querySelector(".sws-coordinator-working");
    expect(line()?.textContent).toMatch(/^Starting the coordinator…\d+s$/);
    expect(container.textContent).not.toContain("Queued for the coordinator.");
    state.runs = [{ id: "run-1", ordinal: 1, status: "running", requestedAt }];
    state.turnItems = [
      { runId: "run-1", ordinal: 2, type: "reasoning", status: "completed" },
      {
        runId: "run-1",
        ordinal: 3,
        type: "dynamic_tool",
        status: "running",
        toolName: "mcp__studio-code__delegate_task",
      },
    ];
    await render();
    expect(line()?.textContent).toContain("Starting a worker…");
    expect(line()?.getAttribute("role")).toBe("status");
    state.runs = [{ id: "run-1", ordinal: 1, status: "completed", requestedAt }];
    await render();
    expect(line()).toBeNull();
    // A finished turn does not bring the Queued notice back.
    expect(container.textContent).not.toContain("Queued for the coordinator.");
  });

  it("does not leave Queued behind a send made while the coordinator is already working", async () => {
    const requestedAt = new Date(Date.now() - 3_000).toISOString();
    state.runs = [{ id: "run-1", ordinal: 1, status: "running", requestedAt }];
    await render();
    await prompt("One more thing");
    await click("Send");
    // The coordinator was already working, so its live line stands in for the receipt.
    expect(container.querySelector(".sws-coordinator-working")).not.toBeNull();
    expect(container.textContent).not.toContain("Queued for the coordinator.");
    state.runs = [{ id: "run-1", ordinal: 1, status: "completed", requestedAt }];
    await render();
    expect(container.querySelector(".sws-coordinator-working")).toBeNull();
    expect(container.textContent).not.toContain("Queued for the coordinator.");
  });

  it("gives way to the failure notice when the turn failed", async () => {
    state.runs = [
      { id: "run-1", ordinal: 1, status: "running", requestedAt: new Date().toISOString() },
    ];
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-1", status: "failed" },
        runtime: { lastError: "You have reached your weekly usage limit." },
      } as unknown as Partial<EnvironmentThreadShell>),
    ];
    await render();
    expect(container.querySelector(".sws-coordinator-working")).toBeNull();
    expect(container.querySelector("[data-coordinator-failure]")).not.toBeNull();
  });
});

describe("thread links inside the project", () => {
  const openThread = (id: string) => container.querySelector(`[data-native-thread="${id}"]`);
  it.each(["user", undefined] as const)(
    "keeps %s-owned independent chats outside the worker pane",
    async (createdBy) => {
      const independent = shell("independent", { createdBy: "user" });
      if (createdBy === undefined) Reflect.deleteProperty(independent, "createdBy");
      state.shells.push(independent);
      await render();
      const pane = container.querySelector('[data-project-pane="threads"]')!;
      expect(pane.querySelector('[data-thread-id="worker"]')).not.toBeNull();
      expect(pane.querySelector('[data-thread-id="independent"]')).toBeNull();
      await act(async () =>
        root.render(
          <ProjectWorkspace
            projectKey="atlas"
            selectedThreadId={"independent" as never}
            onSelectThread={vi.fn()}
          />,
        ),
      );
      expect(openThread("independent")).toBeNull();
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: "host", threadId: "independent" },
        replace: true,
      });
    },
  );
  it("opens a subagent of a project thread in the right panel, whatever its project id", async () => {
    state.shells.push(
      shell("child", {
        projectId: "provider-scratch" as EnvironmentThreadShell["projectId"],
        lineage: {
          relationshipToParent: "subagent",
          parentThreadId: "worker",
          rootThreadId: "worker",
        } as EnvironmentThreadShell["lineage"],
      }),
    );
    state.relatedThreadId = "child";
    await render();
    await openFirstThread();
    await click("Open related thread");
    expect(openThread("child")).not.toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("opens another project's thread full page instead of doing nothing", async () => {
    state.relatedThreadId = "foreign";
    await render();
    await openFirstThread();
    await click("Open related thread");
    expect(openThread("worker")).not.toBeNull();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "foreign" },
    });
  });
  it("opens the thread the URL names and reports selections back to the route", async () => {
    const onSelectThread = vi.fn();
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={"worker" as never}
          onSelectThread={onSelectThread}
        />,
      ),
    );
    expect(openThread("worker")).not.toBeNull();
    await click("Open related thread");
    // Already open: the route is asked again and ignores the repeat.
    expect(onSelectThread).toHaveBeenLastCalledWith("worker");
    await press({ key: "Escape" });
    expect(onSelectThread).toHaveBeenLastCalledWith(null);
  });
  it("hands the route the quoted passage to land on in the opened thread", async () => {
    state.shells.push(shell("quoted"));
    const onSelectThread = vi.fn();
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={"worker" as never}
          onSelectThread={onSelectThread}
        />,
      ),
    );
    const at = { hash: "assistant-citation=abc", state: { assistantCitationActivation: "1" } };
    let opened = false;
    await act(async () => {
      opened = state.routing!.openThread("quoted" as never, undefined, at);
    });
    expect(opened).toBe(true);
    expect(onSelectThread).toHaveBeenLastCalledWith("quoted", at);
  });
  it("sends a URL that names another project's thread to that thread's own page", async () => {
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={"foreign" as never}
          onSelectThread={vi.fn()}
        />,
      ),
    );
    expect(openThread("foreign")).toBeNull();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "foreign" },
      replace: true,
    });
  });
  const renderSelected = async (id: string, onSelectThread = vi.fn()) => {
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={id as never}
          onSelectThread={onSelectThread}
        />,
      ),
    );
    return onSelectThread;
  };
  it("closes the panel on a deleted thread without a new history entry", async () => {
    state.shells.push(shell("gone", { deletedAt: "2026-10-11T00:00:00Z" as never }));
    const onSelectThread = await renderSelected("gone");
    expect(onSelectThread).toHaveBeenCalledWith(null, { replace: true });
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("waits for every host before dropping a thread it has not seen", async () => {
    state.shellsBootstrapped = false;
    const onSelectThread = await renderSelected("later");
    expect(onSelectThread).not.toHaveBeenCalled();
    state.shellsBootstrapped = true;
    await renderSelected("later", onSelectThread);
    expect(onSelectThread).toHaveBeenCalledWith(null, { replace: true });
  });
  it("opens a thread only another machine has on that machine's page", async () => {
    state.shells.push(shell("remote", { environmentId: "laptop" as never }));
    await renderSelected("remote");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "laptop", threadId: "remote" },
      replace: true,
    });
  });
  it("shows the overview on the first press while the URL names a thread not loaded yet", async () => {
    state.shellsBootstrapped = false;
    await renderSelected("later");
    const toggle = () => container.querySelector<HTMLButtonElement>(".sws-overview-toggle")!;
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
  });
  it("keeps one thread opener across renders and lets go of links once the project is left", async () => {
    await render();
    await openFirstThread();
    const routing = state.routing!;
    await prompt("Typing re-renders the project");
    expect(state.routing!.openThread).toBe(routing.openThread);
    await act(async () => root.render(<div />));
    expect(routing.openThread("worker" as never)).toBe(false);
  });
});

describe("switching the coordinator machine", () => {
  it("honors a linked checkout without changing the saved machine", async () => {
    state.otherCheckouts = [
      { id: "remote-project", environmentId: "laptop", workspaceRoot: "/w/atlas" },
    ];
    state.savedMachines = { atlas: "host:project" };
    await act(async () =>
      root.render(<ProjectWorkspace projectKey="atlas" checkoutKey="laptop:remote-project" />),
    );
    await prompt("Use the linked checkout");
    await click("Send");
    expect(state.send.mock.calls.at(-1)?.[0]).toMatchObject({
      environmentId: "laptop",
      input: { projectId: "remote-project" },
    });
    expect(state.savedMachines).toEqual({ atlas: "host:project" });
  });
  it("never substitutes a different checkout when a linked checkout is missing", async () => {
    state.savedMachines = { atlas: "host:project" };
    const onSelectCheckout = vi.fn();
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          checkoutKey="host:removed-project"
          onSelectCheckout={onSelectCheckout}
        />,
      ),
    );
    expect(container.textContent).toContain("Linked checkout unavailable");
    expect(container.querySelector("#project-prompt")).toBeNull();
    expect(state.send).not.toHaveBeenCalled();
    await click("Use host · /scratch/atlas");
    expect(onSelectCheckout).toHaveBeenCalledWith("host:project");
    expect(state.savedMachines).toEqual({ atlas: "host:project" });
  });
  it("closes the open thread instead of leaving for the old machine's page", async () => {
    state.otherCheckouts = [{ id: "project", environmentId: "laptop", workspaceRoot: "/w/atlas" }];
    state.shells.push(shell("old-checkout-thread"));
    const onSelectThread = vi.fn();
    const renderOpen = () =>
      act(async () =>
        root.render(
          <ProjectWorkspace
            projectKey="atlas"
            selectedThreadId={"old-checkout-thread" as never}
            onSelectThread={onSelectThread}
          />,
        ),
      );
    await renderOpen();
    expect(container.querySelector('[data-native-thread="old-checkout-thread"]')).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Coordinator runs on"]')!.click(),
    );
    const laptop = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (element) => element.textContent?.includes("laptop"),
    );
    await act(async () => laptop!.click());
    expect(state.savedMachines).toEqual({ atlas: "laptop:project" });
    // The URL still names the thread until the router catches up.
    await renderOpen();
    expect(onSelectThread).toHaveBeenCalledWith(null, { replace: true });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-native-thread="old-checkout-thread"]')).toBeNull();
  });
});

describe("the coordinator stays in the main column", () => {
  const nativeThread = (id: string) => container.querySelector(`[data-native-thread="${id}"]`);
  const renderSelected = async (id: string, onSelectThread = vi.fn()) => {
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={id as never}
          onSelectThread={onSelectThread}
        />,
      ),
    );
    return onSelectThread;
  };
  it("lets go of a URL that names the coordinator, without a new history entry", async () => {
    const onSelectThread = await renderSelected("coord");
    expect(nativeThread("coord")).toBeNull();
    expect(onSelectThread).toHaveBeenCalledWith(null, { replace: true });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Coordinator conversation"]')).not.toBeNull();
  });
  it("shows the main conversation for a link to the coordinator from an open thread", async () => {
    state.relatedThreadId = "coord";
    await render();
    await openFirstThread();
    expect(nativeThread("worker")).not.toBeNull();
    await click("Open related thread");
    expect(nativeThread("coord")).toBeNull();
    expect(nativeThread("worker")).toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("answers the routing's own coordinator request the same way", async () => {
    await render();
    await openFirstThread();
    await act(async () => state.routing!.openCoordinator());
    expect(nativeThread("coord")).toBeNull();
    expect(nativeThread("worker")).toBeNull();
  });
  it("keeps the status chip in the main column", async () => {
    await render();
    await openFirstThread();
    const chip = container.querySelector<HTMLButtonElement>(".sws-state")!;
    expect(chip.textContent).toContain("Idle");
    await act(async () => chip.click());
    expect(nativeThread("coord")).toBeNull();
    expect(nativeThread("worker")).toBeNull();
  });
  it.each(["hasPendingApprovals", "hasPendingUserInput", "hasActionableProposedPlan"] as const)(
    "reviews %s inside the coordinator pane while preserving worker and draft",
    async (attention) => {
      state.shells = state.shells.map((t) => (t.id === "coord" ? { ...t, [attention]: true } : t));
      await render();
      await openFirstThread();
      await prompt("Keep my coordinator draft");
      const chip = container.querySelector<HTMLButtonElement>(".sws-state")!;
      expect(chip.dataset.opens).toBe("coordinator-review");
      chip.focus();
      await act(async () => chip.click());
      expect(state.navigate).not.toHaveBeenCalled();
      expect(nativeThread("coord")?.closest('[data-project-pane="coordinator"]')).not.toBeNull();
      expect(nativeThread("worker")?.closest('[data-project-pane="threads"]')).not.toBeNull();
      await click("Back to coordinator");
      expect(nativeThread("coord")).toBeNull();
      expect(nativeThread("worker")).not.toBeNull();
      expect(document.activeElement).toBe(chip);
      expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
        "Keep my coordinator draft",
      );
    },
  );
  it("saves the project model from coordinator details before routing a reply", async () => {
    state.shells = state.shells.map((t) =>
      t.id === "coord" ? { ...t, hasPendingApprovals: true } : t,
    );
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".sws-state")!.click());
    const details = nativeThread("coord")!;
    const picker = details.querySelector<HTMLButtonElement>("[data-coordinator-model]")!;
    expect(picker.textContent).toBe("coordinator-model");
    let resolveSave!: (value: unknown) => void;
    state.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    await act(async () => {
      picker.click();
      [...details.querySelectorAll("button")]
        .find((button) => button.textContent === "Reply in selected thread")!
        .click();
    });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]![0].input.workspaceSettings.coordinatorModelSelection).toEqual({
      instanceId: "codex-native",
      model: "picked-model",
    });
    await act(async () => resolveSave({ _tag: "Success", value: undefined }));
    expect(state.send).toHaveBeenCalledTimes(2);
    expect(state.send.mock.calls[1]![0].input).toMatchObject({
      projectId: "project",
      prompt: "Continue this worker",
    });
    expect(state.send.mock.calls[1]![0].input.sourceThreadId).toBeUndefined();
  });
  it.each(["Resume", "Plan"])(
    "%s in native review uses the acknowledged project selection, not the stale projection",
    async (kind) => {
      state.shells = state.shells.map((t) =>
        t.id === "coord" ? { ...t, hasPendingApprovals: true } : t,
      );
      await render();
      await act(async () => container.querySelector<HTMLButtonElement>(".sws-state")!.click());
      const details = nativeThread("coord")!;
      let resolveSave!: (value: unknown) => void;
      state.send.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          }),
      );
      await act(async () => {
        details.querySelector<HTMLButtonElement>("[data-coordinator-model]")!.click();
        [...details.querySelectorAll("button")]
          .find((button) => button.textContent === `${kind} native`)!
          .click();
      });
      expect(state.nativeContinue).not.toHaveBeenCalled();
      await act(async () => resolveSave({ _tag: "Success", value: undefined }));
      expect(state.nativeContinue).toHaveBeenCalledExactlyOnceWith(kind, {
        instanceId: "codex-native",
        model: "picked-model",
      });
      expect(state.send).toHaveBeenCalledOnce();
    },
  );
  it("uses the acknowledged revision for another model change before projection refresh", async () => {
    await render();
    const picker = container.querySelector<HTMLButtonElement>("[data-coordinator-model]")!;
    await act(async () => picker.click());
    await act(async () => picker.click());
    expect(
      state.send.mock.calls.map(([call]) => call.input.workspaceSettings.expectedRevision),
    ).toEqual([1, 2]);
  });
  it("does not resume native review when the project model save failed", async () => {
    state.shells = state.shells.map((t) =>
      t.id === "coord" ? { ...t, hasPendingApprovals: true } : t,
    );
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".sws-state")!.click());
    const details = nativeThread("coord")!;
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Conflict") });
    await act(async () =>
      details.querySelector<HTMLButtonElement>("[data-coordinator-model]")!.click(),
    );
    await act(async () =>
      [...details.querySelectorAll("button")]
        .find((button) => button.textContent === "Resume native")!
        .click(),
    );
    expect(state.nativeContinue).not.toHaveBeenCalled();
    expect(state.nativeError).toContain("Conflict");
  });
  it("shows a model save failure while coordinator review stays open", async () => {
    state.shells = state.shells.map((t) =>
      t.id === "coord" ? { ...t, hasPendingApprovals: true } : t,
    );
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".sws-state")!.click());
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Host went away") });
    await act(async () =>
      nativeThread("coord")!.querySelector<HTMLButtonElement>("[data-coordinator-model]")!.click(),
    );
    expect(
      container.querySelector('[aria-label="Coordinator review"] [role="alert"]')?.textContent,
    ).toBe("Host went away");
  });
  it("lists neither the coordinator nor a previous one among the project's threads", async () => {
    state.shells.push(shell("project-coordinator:project", { title: "Old coordinator" }));
    await render();
    const pane = container.querySelector("#project-threads-pane")!;
    expect(pane.querySelector('[data-thread-id="coord"]')).toBeNull();
    expect(pane.querySelector('[data-thread-id="project-coordinator:project"]')).toBeNull();
    expect(pane.querySelector('[data-thread-id="worker"]')).not.toBeNull();
  });
  it("opens a previous coordinator full page, where its history is, never in the panel", async () => {
    state.shells.push(shell("project-coordinator:project", { title: "Old coordinator" }));
    state.relatedThreadId = "project-coordinator:project";
    await render();
    await openFirstThread();
    await click("Open related thread");
    expect(nativeThread("project-coordinator:project")).toBeNull();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "project-coordinator:project" },
    });
  });
  it("treats the host's coordinator id as the coordinator before the settings name one", async () => {
    state.coordinatorId = null;
    const onSelectThread = await renderSelected("project-coordinator:project");
    expect(onSelectThread).toHaveBeenCalledWith(null, { replace: true });
    expect(state.navigate).not.toHaveBeenCalled();
  });
});

describe("thread cards' quick actions", () => {
  const announce = (overrides: Partial<EnvironmentThreadShell> = {}) => {
    state.shells.push(
      shell("fresh", {
        title: "Skills consolidation",
        createdAt: "2026-10-11T05:00:03Z",
        branch: "skills",
        ...overrides,
      } as Partial<EnvironmentThreadShell>),
    );
    state.messages = [
      {
        id: "ask",
        role: "user",
        createdBy: "user",
        text: "Consolidate the skills.",
        createdAt: "2026-10-11T05:00:00Z",
        streaming: false,
        attachments: [],
      },
      {
        id: "ack",
        role: "assistant",
        createdBy: "agent",
        text: "Started [Skills consolidation](studio://thread/fresh).",
        createdAt: "2026-10-11T05:00:04Z",
        updatedAt: "2026-10-11T05:00:05Z",
        streaming: false,
        attachments: [],
      },
    ];
  };
  const git = (overrides: Record<string, unknown> = {}) => ({
    isRepo: true,
    refName: "skills",
    isDefaultRef: false,
    hasPrimaryRemote: true,
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 3, deletions: 1 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  });
  const card = () => container.querySelector<HTMLElement>('[data-thread-card="fresh"]')!;
  const actions = () => [...card().querySelectorAll("button")].map((b) => b.textContent);
  it("offers Create PR for unshipped changes and runs it beside the thread", async () => {
    announce();
    state.git = git();
    await render();
    expect(actions()).toEqual(["View thread", "Create PR"]);
    // A title cut short in a narrow panel can still be read in full on hover.
    const title = card().querySelector<HTMLElement>(".sws-thread-card-title")!;
    expect(title.getAttribute("data-slot")).toBe("tooltip-trigger");
    const create = card().querySelector<HTMLButtonElement>('[data-action="create-pr"]')!;
    expect(create.getAttribute("aria-label")).toBe(
      "Create a pull request for Skills consolidation",
    );
    await act(async () => create.click());
    const ref = { environmentId: "host", threadId: "fresh" };
    expect(state.pullRequestRequests).toEqual([ref]);
    expect(state.detailsPanelsShown).toEqual([ref]);
    expect(container.querySelector('[data-native-thread="fresh"]')).not.toBeNull();
  });
  it("offers View PR once the thread has one, and opens it", async () => {
    announce({
      pullRequests: [
        {
          host: "github.com",
          repository: "acme/atlas",
          number: 42,
          url: "https://github.com/acme/atlas/pull/42",
          source: "created",
          linkedAt: "2026-10-11T05:01:00Z",
          snapshot: { state: "open", isDraft: false, title: "Skills", updatedAt: "2026-10-11" },
        },
      ] as never,
    });
    state.git = git();
    await render();
    expect(actions()).toEqual(["View thread", "View PR"]);
    await act(async () =>
      card().querySelector<HTMLButtonElement>('[data-action="view-pr"]')!.click(),
    );
    expect(state.openLink).toHaveBeenCalledWith("https://github.com/acme/atlas/pull/42");
  });
  it("leaves Create PR out on a read-only connection", async () => {
    announce();
    state.git = git();
    state.canOperate = false;
    await render();
    expect(actions()).toEqual(["View thread"]);
  });
  it("leaves Create PR out when the grant can operate but not change source control", async () => {
    announce();
    state.git = git();
    state.canWriteSourceControl = false;
    await render();
    expect(actions()).toEqual(["View thread"]);
  });
  it("says why when nothing acted on Create PR by the deadline", async () => {
    vi.useFakeTimers();
    try {
      announce();
      state.git = git();
      state.expireResult = true;
      await render();
      await act(async () =>
        card().querySelector<HTMLButtonElement>('[data-action="create-pr"]')!.click(),
      );
      const { toastManager } = await import("../ui/toast");
      const add = vi.mocked(toastManager.add);
      add.mockClear();
      await act(async () => vi.advanceTimersByTime(16_000));
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "No pull request opened",
          description: "Nothing answered.",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("project request drafts from PR actions", () => {
  it("appends a request to the current draft once without sending or replacing the worker pane", async () => {
    await render();
    await openFirstThread();
    await prompt("Keep my draft");
    await act(async () =>
      enqueueProjectCoordinatorDraft({
        environmentId: "host",
        projectId: "project",
        text: "Review PR 42",
      }),
    );
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "Keep my draft\n\nReview PR 42",
    );
    expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
    expect(state.send).not.toHaveBeenCalled();
    await render();
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "Keep my draft\n\nReview PR 42",
    );
  });
  it("keeps a staged request for its exact checkout until that checkout opens", async () => {
    enqueueProjectCoordinatorDraft({
      environmentId: "laptop",
      projectId: "remote-project",
      text: "Fix PR 9",
    });
    await render();
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("");
    state.otherCheckouts = [
      { id: "remote-project", environmentId: "laptop", workspaceRoot: "/w/atlas" },
    ];
    await act(async () =>
      root.render(<ProjectWorkspace projectKey="atlas" checkoutKey="laptop:remote-project" />),
    );
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("Fix PR 9");
    expect(state.send).not.toHaveBeenCalled();
  });
});
