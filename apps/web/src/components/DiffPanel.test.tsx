// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, RunId, ThreadId, type ScopedThreadRef } from "@specweave-studio/contracts";
import { scopeThreadRef, scopedThreadKey } from "@specweave-studio/client-runtime/environment";

const state = vi.hoisted(() => ({
  route: {} as Record<string, string>,
  shells: new Map<string, any>(),
  projections: new Map<string, any>(),
  shellReads: [] as any[],
  projectionReads: [] as any[],
  queries: [] as any[],
  checkpoints: [] as any[],
  refreshes: [] as any[],
  canReadFiles: true,
  checkpointError: null as string | null,
  checkpointDiff: { diff: "" } as { diff: string; truncated?: boolean },
  diffFilesCollapsed: false,
  machineNames: {} as Record<string, string>,
  scrolls: [] as any[],
  toast: vi.fn(),
  refresh: vi.fn(),
  command: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: ({ select }: any) => select(state.route),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ availableEditors: [] }) }));
vi.mock("../state/entities", () => ({
  useThreadShell: (ref: ScopedThreadRef | null) => {
    state.shellReads.push(ref);
    return ref ? (state.shells.get(`${ref.environmentId}:${ref.threadId}`) ?? null) : null;
  },
  useThreadProjection: (ref: ScopedThreadRef | null) => {
    state.projectionReads.push(ref);
    return ref ? (state.projections.get(`${ref.environmentId}:${ref.threadId}`) ?? null) : null;
  },
  useProject: () => null,
}));
vi.mock("../state/filesystem", () => ({
  useFilesystemReadAccess: () => ({
    canReadFiles: state.canReadFiles,
    isPending: false,
    error: "Read denied",
  }),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => ({
    diffLayout: "split",
    wordWrap: false,
    diffIgnoreWhitespace: true,
    diffFilesCollapsed: state.diffFilesCollapsed,
    timestampFormat: "24h",
  }),
  useUpdateClientSettings: () => state.command,
}));
vi.mock("../hooks/useLocalStorage", async () => {
  const { useState } = await import("react");
  return { useLocalStorage: (_key: string, initial: boolean) => useState(initial) };
});
vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: (projection: any) => ({
    turnDiffSummaries: projection?.summaries ?? [],
    inferredCheckpointTurnCountByRunId: {},
  }),
}));
vi.mock("../hooks/useWorkspaceMutationRefresh", () => ({
  useWorkspaceMutationRefresh: (input: any) => state.refreshes.push(input),
}));
vi.mock("../lib/checkpointDiffState", () => ({
  useCheckpointDiff: (input: any, options: any) => {
    state.checkpoints.push({ ...input, ...options });
    return {
      data: state.checkpointError || !options?.enabled ? undefined : state.checkpointDiff,
      isPending: false,
      error: options?.enabled ? state.checkpointError : null,
    };
  },
}));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: (id: unknown) => id } }));
vi.mock("../state/review", () => ({
  reviewEnvironment: {
    diffFileContents: {},
    diffPreview: (input: any) => ({ kind: "diff", ...input }),
  },
}));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: {
    status: (input: any) => ({ kind: "status", ...input }),
    listRefs: (input: any) => ({ kind: "refs", ...input }),
  },
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (query: any) => {
    if (query) state.queries.push(query);
    return {
      data: query?.kind === "status" ? { isRepo: true } : undefined,
      isPending: false,
      error: null,
      refresh: state.refresh,
    };
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => state.command }));
vi.mock("../fileContextMenu", () => ({ useFileContextMenuHandler: () => state.command }));
vi.mock("../studio/machineNickname", () => ({
  useMachineNicknames: () => (environmentId: string) =>
    state.machineNames[environmentId] ?? environmentId,
}));
vi.mock("./ui/toast", () => ({ toastManager: { add: state.toast } }));
const NO_FILES: never[] = [];
vi.mock("./diffs/useReviewFilePatches", () => ({
  // A turn diff renders its parsed patch as is, which is what the real hook does without a lazy source.
  useReviewFilePatches: (input: any) => {
    const files = input.preview?.kind === "files" ? input.preview.files : NO_FILES;
    return {
      scope: "fixture",
      isPending: false,
      fileStates: new Map(),
      retry: state.command,
      requestFile: state.command,
      readyFilePaths: new Set(),
      renderableFiles: files,
      settledFileCount: files.length,
      loadNextFiles: state.command,
    };
  },
}));
// The component, route resolution, file reveal, path matching and the per-thread
// selection and right-panel stores are real. The code view is replaced by its file
// headers (title and collapsed state) and a viewer handle that records scrolls; I/O
// hooks are substituted, and no provider or server runs.
vi.mock("./diffs/AnnotatableCodeView", async () => {
  const { useEffect } = await import("react");
  return {
    AnnotatableCodeView: (props: any) => {
      const { viewerRef } = props;
      useEffect(() => {
        if (typeof viewerRef !== "function") return;
        viewerRef({
          getInstance: () => ({}),
          scrollTo: (target: unknown) => state.scrolls.push(target),
        });
        return () => viewerRef(null);
      }, [viewerRef]);
      return (
        <div data-testid="code-view">
          {props.files.map((file: any) => (
            <div
              key={file.fileKey}
              data-diffs-header=""
              data-file={file.filePath}
              data-file-key={file.fileKey}
              data-collapsed={String(file.collapsed)}
            >
              <span data-title="">{file.filePath}</span>
            </div>
          ))}
        </div>
      );
    },
  };
});

import DiffPanel from "./DiffPanel";
import { EmbeddedThreadDiffPanel } from "./chat/EmbeddedThreadDiffPanel";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

let root: Root;
let container: HTMLDivElement;
const worker = scopeThreadRef(EnvironmentId.make("remote-a"), ThreadId.make("worker"));
const otherEnvironment = scopeThreadRef(EnvironmentId.make("remote-b"), worker.threadId);
const routeThread = scopeThreadRef(EnvironmentId.make("local"), ThreadId.make("coordinator"));
const runId = RunId.make("worker-run");

function addThread(ref: ScopedThreadRef) {
  state.shells.set(scopedThreadKey(ref), {
    environmentId: ref.environmentId,
    id: ref.threadId,
    projectId: null,
    worktreePath: `/fixture/${ref.environmentId}/${ref.threadId}`,
  });
  state.projections.set(scopedThreadKey(ref), {
    projection: {
      summaries: [
        {
          runId,
          checkpointTurnCount: 1,
          status: "ready",
          files: [],
          completedAt: "2026-10-14T12:00:00Z",
        },
      ],
      runs: [{ id: runId, status: "completed" }],
    },
  });
}

async function render(ref: ScopedThreadRef | undefined, embedded = false) {
  await act(async () =>
    root.render(
      embedded && ref ? (
        <EmbeddedThreadDiffPanel
          threadRef={ref}
          composerDraftTarget={ref}
          workspaceMutationId={null}
        />
      ) : (
        <DiffPanel
          {...(ref ? { threadRef: ref } : {})}
          composerDraftTarget={ref ?? routeThread}
          workspaceMutationId={null}
        />
      ),
    ),
  );
}

function clearReads() {
  state.shellReads = [];
  state.projectionReads = [];
  state.queries = [];
  state.checkpoints = [];
  state.refreshes = [];
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.route = {};
  state.shells.clear();
  state.projections.clear();
  state.canReadFiles = true;
  state.checkpointError = null;
  state.checkpointDiff = { diff: "" };
  state.diffFilesCollapsed = false;
  state.machineNames = {};
  state.scrolls = [];
  state.toast.mockClear();
  state.command.mockClear();
  state.refresh.mockClear();
  clearReads();
  useDiffPanelStore.setState({
    byThreadKey: {},
    branchBaseRefByThreadKey: {},
    pendingLinkedOpenThreadKey: null,
  });
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  addThread(worker);
  addThread(otherEnvironment);
  addThread(routeThread);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("diff panel thread ownership", () => {
  it("opens the selected project worker without thread route parameters", async () => {
    state.route = { projectKey: "project" };
    useDiffPanelStore.getState().selectTurn(worker, runId, "value.cjs");
    await render(worker, true);
    expect(container.textContent).not.toContain("Select a thread");
    expect(state.shellReads.at(-1)).toEqual(worker);
    expect(state.projectionReads.at(-1)).toEqual(worker);
    expect(state.checkpoints.at(-1)).toMatchObject({
      ...worker,
      fromTurnCount: 0,
      toTurnCount: 1,
      enabled: true,
    });
    expect(state.queries.every((query) => query.environmentId === worker.environmentId)).toBe(true);
  });

  it("uses explicit selection instead of a conflicting standalone route", async () => {
    state.route = routeThread;
    await render(worker);
    expect(state.shellReads.at(-1)).toEqual(worker);
    expect(state.queries.find((query) => query.kind === "diff")).toMatchObject({
      environmentId: worker.environmentId,
      input: { cwd: "/fixture/remote-a/worker" },
    });
    expect(state.refreshes.at(-1).resourceKey).toBe("diff:remote-a:worker");
    expect(state.queries.some((query) => query.environmentId === routeThread.environmentId)).toBe(
      false,
    );
  });

  it("switches identical thread IDs across environments without carrying selections or reads", async () => {
    useDiffPanelStore.getState().selectTurn(worker, runId, "value.cjs");
    useDiffPanelStore.getState().selectGitScope(otherEnvironment, "unstaged");
    await render(worker, true);
    clearReads();
    await render(otherEnvironment, true);
    expect(state.shellReads.at(-1)).toEqual(otherEnvironment);
    expect(state.checkpoints.at(-1)).toMatchObject({ ...otherEnvironment, enabled: false });
    expect(state.queries.some((query) => query.environmentId === worker.environmentId)).toBe(false);
    expect(container.querySelector('[aria-label="Diff scope: Uncommitted"]')).not.toBeNull();
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, worker),
    ).toMatchObject({ kind: "turn", turnId: runId });
  });

  it("preserves standalone route resolution when the override is omitted", async () => {
    state.route = routeThread;
    await render(undefined);
    expect(container.textContent).not.toContain("Select a thread");
    expect(state.shellReads.at(-1)).toEqual(routeThread);
    expect(state.queries.find((query) => query.kind === "diff")).toMatchObject({
      environmentId: routeThread.environmentId,
    });
  });

  it("does not fall back to another route when the explicit worker shell is missing", async () => {
    state.route = routeThread;
    state.shells.delete(scopedThreadKey(worker));
    await render(worker);
    expect(container.textContent).toContain("Select a thread");
    expect(state.shellReads.at(-1)).toEqual(worker);
    expect(state.queries).toEqual([]);
  });

  it("retains the missing-checkpoint refusal for the selected worker", async () => {
    state.checkpointError = "Checkpoint range unavailable";
    useDiffPanelStore.getState().selectTurn(worker, runId);
    await render(worker, true);
    expect(state.checkpoints.at(-1)).toMatchObject({ ...worker, enabled: true });
    expect(container.textContent).toContain("Checkpoint range unavailable");
    expect(state.queries.some((query) => query.kind === "diff")).toBe(false);
  });

  it("does not request workspace diffs when file access is denied", async () => {
    state.canReadFiles = false;
    await render(worker, true);
    expect(container.textContent).toContain("Read denied");
    expect(state.queries.some((query) => query.kind === "diff")).toBe(false);
  });
});

// A thread whose folder is apps/web inside the repository at /repo. Checkpoint patch paths
// are relative to /repo, while providers report absolute or folder-relative paths.
const appThread = scopeThreadRef(EnvironmentId.make("m4"), ThreadId.make("app-thread"));
const firstRun = RunId.make("run-1");
const editRun = RunId.make("run-2");
const laterRun = RunId.make("run-3");
const TURN_PATCH = [
  "diff --git a/apps/web/src/App.tsx b/apps/web/src/App.tsx",
  "index 1111111..2222222 100644",
  "--- a/apps/web/src/App.tsx",
  "+++ b/apps/web/src/App.tsx",
  "@@ -1,3 +1,4 @@",
  ' import { a } from "./a";',
  '+import { b } from "./b";',
  " export const App = a;",
  " export default App;",
  "diff --git a/apps/web/src/main.ts b/apps/web/src/main.ts",
  "index 3333333..4444444 100644",
  "--- a/apps/web/src/main.ts",
  "+++ b/apps/web/src/main.ts",
  "@@ -5,3 +5,3 @@",
  " start();",
  "-render();",
  "+render(App);",
  " done();",
].join("\n");
const CARD_FILES = ["apps/web/src/App.tsx", "apps/web/src/main.ts", "apps/web/src/format.ts"];

function turnCheckpoint(run: RunId, turnCount: number, overrides: Record<string, unknown> = {}) {
  return {
    runId: run,
    checkpointTurnCount: turnCount,
    status: "ready",
    files: CARD_FILES.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
    completedAt: `2026-10-2${turnCount}T12:00:00Z`,
    cwd: "/repo/apps/web",
    repoRoot: "/repo",
    branch: "main",
    headOid: "abc1234def5678",
    capturedOnEnvironmentId: "m4",
    ...overrides,
  };
}

function setAppThread(input: {
  readonly summaries?: ReadonlyArray<unknown>;
  readonly runs?: ReadonlyArray<{ id: RunId; status: string }>;
  readonly worktreePath?: string;
}) {
  state.shells.set(scopedThreadKey(appThread), {
    environmentId: appThread.environmentId,
    id: appThread.threadId,
    projectId: null,
    worktreePath: input.worktreePath ?? "/repo/apps/web",
  });
  state.projections.set(scopedThreadKey(appThread), {
    projection: {
      summaries: input.summaries ?? [turnCheckpoint(firstRun, 1), turnCheckpoint(editRun, 2)],
      runs: input.runs ?? [
        { id: firstRun, status: "completed" },
        { id: editRun, status: "completed" },
      ],
    },
  });
}

async function openLink(
  run: RunId,
  filePath?: string,
  options: Parameters<ReturnType<typeof useDiffPanelStore.getState>["selectTurn"]>[3] = {},
) {
  useDiffPanelStore.getState().selectTurn(appThread, run, filePath, options);
  await render(appThread);
}

function fileHeader(path: string) {
  return container.querySelector<HTMLElement>(`[data-file="${path}"]`);
}

async function clickFileTitle(path: string) {
  await act(async () => {
    fileHeader(path)
      ?.querySelector("[data-title]")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openedFile() {
  const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, appThread);
  return panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null;
}

describe("Open diff links", () => {
  beforeEach(() => {
    state.checkpointDiff = { diff: TURN_PATCH };
    setAppThread({});
  });

  it.each([
    { label: "an absolute provider path", path: "/repo/apps/web/src/App.tsx" },
    { label: "a path relative to the thread's subfolder", path: "src/App.tsx" },
    { label: "a card row's repository path", path: "apps/web/src/App.tsx" },
  ])(
    "opens $label at that run's file, expanded although files start collapsed",
    async ({ path }) => {
      state.diffFilesCollapsed = true;
      await openLink(firstRun, path);

      expect(state.checkpoints.at(-1)).toMatchObject({
        ...appThread,
        fromTurnCount: 0,
        toTurnCount: 1,
        enabled: true,
      });
      expect(fileHeader("apps/web/src/App.tsx")?.dataset.collapsed).toBe("false");
      expect(fileHeader("apps/web/src/main.ts")?.dataset.collapsed).toBe("true");
      expect(state.scrolls).toContainEqual({
        type: "item",
        id: fileHeader("apps/web/src/App.tsx")?.dataset.fileKey,
        align: "start",
      });
      expect(container.textContent).not.toContain("Matched by file name");
      expect(container.textContent).not.toContain("is not in this diff");
    },
  );

  it("labels a unique file-name match on a checkpoint without a stamped repository", async () => {
    setAppThread({
      summaries: [turnCheckpoint(editRun, 2, { cwd: undefined, repoRoot: undefined })],
    });
    await openLink(editRun, "/repo/apps/web/src/main.ts");

    expect(fileHeader("apps/web/src/main.ts")?.dataset.collapsed).toBe("false");
    expect(container.textContent).toContain("Matched by file name: apps/web/src/main.ts");
  });

  it("never shows another turn's diff when the linked run recorded none", async () => {
    await openLink(RunId.make("run-unknown"), "/repo/apps/web/src/App.tsx");

    expect(container.textContent).toContain("No diff recorded for this turn");
    expect(container.querySelector('[data-testid="code-view"]')).toBeNull();
    expect(state.checkpoints.at(-1)).toMatchObject({ enabled: false });
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, appThread),
    ).toMatchObject({ kind: "turn", turnId: "run-unknown", origin: "link" });
  });

  it("still falls back to the latest turn for the panel's own stale turn choice", async () => {
    useDiffPanelStore.getState().selectTurn(appThread, RunId.make("run-unknown"));
    await render(appThread);

    expect(state.checkpoints.at(-1)).toMatchObject({ toTurnCount: 2, enabled: true });
    expect(container.querySelector('[aria-label="Diff scope: Latest turn"]')).not.toBeNull();
  });

  it.each([
    {
      label: "a running turn",
      runStatus: "running",
      checkpoint: null,
      message: "Diff available when the turn ends",
    },
    {
      label: "a failed snapshot",
      runStatus: "completed",
      checkpoint: { status: "error" },
      message: "No diff: this turn's snapshot failed",
    },
    {
      label: "a missing snapshot",
      runStatus: "completed",
      checkpoint: { status: "missing" },
      message: "No diff: this turn's snapshot is missing",
    },
    {
      label: "an out-of-date snapshot",
      runStatus: "completed",
      checkpoint: { status: "stale" },
      message: "No diff: this turn's snapshot is out of date",
    },
    {
      label: "a folder outside Git",
      runStatus: "completed",
      checkpoint: { status: "missing", notGitRepository: true },
      message: "No diff: this folder is not a Git repository",
    },
    {
      label: "a turn that failed before its snapshot",
      runStatus: "failed",
      checkpoint: null,
      message: "No diff: this turn ended with an error before a snapshot was taken",
    },
  ])("shows its own notice for $label", async ({ runStatus, checkpoint, message }) => {
    setAppThread({
      summaries: [
        turnCheckpoint(firstRun, 1),
        ...(checkpoint ? [turnCheckpoint(laterRun, 2, checkpoint)] : []),
      ],
      runs: [
        { id: firstRun, status: "completed" },
        { id: laterRun, status: runStatus },
      ],
    });
    await openLink(laterRun, "/repo/apps/web/src/App.tsx");

    expect(container.textContent).toContain(message);
    expect(container.querySelector('[data-testid="code-view"]')).toBeNull();
    expect(state.checkpoints.every((call) => call.enabled === false)).toBe(true);
  });

  it.each(["interrupted", "cancelled"])("opens the diff of a %s turn", async (runStatus) => {
    setAppThread({
      runs: [
        { id: firstRun, status: "completed" },
        { id: editRun, status: runStatus },
      ],
    });
    await openLink(editRun, "/repo/apps/web/src/main.ts");

    expect(state.checkpoints.at(-1)).toMatchObject({
      fromTurnCount: 1,
      toTurnCount: 2,
      enabled: true,
    });
    expect(fileHeader("apps/web/src/main.ts")).not.toBeNull();
  });

  it("opens the turn after a failed turn against the snapshot before it", async () => {
    setAppThread({
      summaries: [turnCheckpoint(firstRun, 1), turnCheckpoint(laterRun, 3)],
      runs: [
        { id: firstRun, status: "completed" },
        { id: editRun, status: "failed" },
        { id: laterRun, status: "completed" },
      ],
    });
    await openLink(laterRun, "/repo/apps/web/src/App.tsx");

    expect(state.checkpoints.at(-1)).toMatchObject({
      fromTurnCount: 2,
      toTurnCount: 3,
      enabled: true,
    });
    expect(fileHeader("apps/web/src/App.tsx")?.dataset.collapsed).toBe("false");
  });
});

describe("a requested file missing from the turn diff", () => {
  beforeEach(() => {
    state.checkpointDiff = { diff: TURN_PATCH };
    setAppThread({});
  });

  it("names a path outside the checkpoint folder", async () => {
    await openLink(editRun, "/repo/apps/server/src/main.ts");

    expect(container.textContent).toContain(
      "/repo/apps/server/src/main.ts is not in this diff: outside the checkpoint folder /repo/apps/web",
    );
  });

  it("offers one click to show a file that Ignore whitespace hid", async () => {
    await openLink(editRun, "/repo/apps/web/src/format.ts");

    expect(container.textContent).toContain(
      "apps/web/src/format.ts is not in this diff: hidden by Ignore whitespace",
    );
    expect(state.checkpoints.at(-1)).toMatchObject({ ignoreWhitespace: true });
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === "Show whitespace changes",
    );
    await act(async () => button?.click());
    expect(state.checkpoints.at(-1)).toMatchObject({ ignoreWhitespace: false });
  });

  it("lists card files a truncated patch never reached", async () => {
    state.checkpointDiff = { diff: TURN_PATCH, truncated: true };
    await openLink(editRun, "/repo/apps/web/src/format.ts");

    expect(container.textContent).toContain("Diff truncated at 10 MB");
    expect(
      container.querySelector('[aria-label="Files beyond the diff size limit"]')?.textContent,
    ).toBe("apps/web/src/format.ts: beyond the diff size limit");
    expect(container.textContent).toContain(
      "apps/web/src/format.ts is not in this diff: beyond the diff size limit",
    );
  });

  it("says a file outside the card is not in the snapshot", async () => {
    await openLink(editRun, "/repo/apps/web/dist/bundle.js");

    expect(container.textContent).toContain(
      "apps/web/dist/bundle.js is not in this diff: not in this turn's snapshot (ignored path, nested repository or reverted)",
    );
  });
});

describe("turn provenance and attribution", () => {
  beforeEach(() => {
    state.checkpointDiff = { diff: TURN_PATCH };
    state.machineNames = { m4: "M4", mini: "Mini" };
  });

  it("shows turn, repository, folder, branch at short HEAD and the capturing machine", async () => {
    setAppThread({});
    await openLink(editRun, "/repo/apps/web/src/App.tsx");

    const header = container.querySelector('[aria-label="Turn snapshot"]');
    expect(header?.textContent).toBe("Turn 2repo/repo/apps/webmain@abc1234M4");
  });

  it("omits the branch when HEAD was detached", async () => {
    setAppThread({ summaries: [turnCheckpoint(editRun, 2, { branch: null })] });
    await openLink(editRun);

    const header = container.querySelector('[aria-label="Turn snapshot"]');
    expect(header?.textContent).toContain("/repo/apps/webabc1234");
    expect(header?.textContent).not.toContain("@");
  });

  it("renders a checkpoint without a stamp as before", async () => {
    setAppThread({
      summaries: [
        turnCheckpoint(editRun, 2, {
          cwd: undefined,
          repoRoot: undefined,
          branch: undefined,
          headOid: undefined,
          capturedOnEnvironmentId: undefined,
        }),
      ],
    });
    await openLink(editRun, "apps/web/src/App.tsx");

    expect(container.querySelector('[aria-label="Turn snapshot"]')).toBeNull();
    expect(fileHeader("apps/web/src/App.tsx")).not.toBeNull();
  });

  it("says when another machine took the snapshot, and why its refs are absent here", async () => {
    setAppThread({ summaries: [turnCheckpoint(editRun, 2, { capturedOnEnvironmentId: "mini" })] });
    state.checkpointError = "Checkpoint ref is unavailable";
    await openLink(editRun, "/repo/apps/web/src/App.tsx");

    expect(container.querySelector('[aria-label="Turn snapshot"]')?.textContent).toContain(
      "Captured on Mini, served by M4",
    );
    expect(container.textContent).toContain("This turn's snapshot was taken on Mini");
  });

  it.each([
    { running: false, notice: "Edited by subagent Refactor parser in turn 2" },
    {
      running: true,
      notice:
        "Edited by subagent Refactor parser in turn 2. It was still running when this snapshot was taken, so the change may appear in a later turn.",
    },
  ])("names the subagent that made the edit (running: $running)", async ({ running, notice }) => {
    setAppThread({});
    await openLink(editRun, "/repo/apps/web/src/App.tsx", {
      sourceThreadId: appThread.threadId,
      attributedTo: { title: "Refactor parser", running },
    });

    expect(container.textContent).toContain(notice);
    expect(fileHeader("apps/web/src/App.tsx")?.dataset.collapsed).toBe("false");
  });
});

describe("opening a turn's file in the editor", () => {
  beforeEach(() => {
    state.checkpointDiff = { diff: TURN_PATCH };
  });

  it("opens the latest turn's file at its first changed line while no run is active", async () => {
    setAppThread({});
    await openLink(editRun, "/repo/apps/web/src/main.ts");
    await clickFileTitle("apps/web/src/main.ts");

    expect(openedFile()).toMatchObject({ relativePath: "src/main.ts", revealLine: 6 });
    expect(state.toast).not.toHaveBeenCalled();
  });

  it("opens an older turn's file at the top and says it is the current file", async () => {
    setAppThread({});
    await openLink(firstRun, "/repo/apps/web/src/App.tsx");
    await clickFileTitle("apps/web/src/App.tsx");

    expect(openedFile()).toMatchObject({ relativePath: "src/App.tsx", revealLine: null });
    expect(state.toast).toHaveBeenCalledWith({
      type: "info",
      title: "Showing the current file; it may differ from this turn",
    });
  });

  it("opens the latest turn at the top while another run is active", async () => {
    setAppThread({
      runs: [
        { id: firstRun, status: "completed" },
        { id: editRun, status: "completed" },
        { id: laterRun, status: "running" },
      ],
    });
    await openLink(editRun, "/repo/apps/web/src/App.tsx");
    await clickFileTitle("apps/web/src/App.tsx");

    expect(openedFile()).toMatchObject({ revealLine: null });
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Showing the current file; it may differ from this turn" }),
    );
  });

  it("names both folders when the thread's worktree changed after the turn", async () => {
    setAppThread({ worktreePath: "/worktrees/feature-b/apps/web" });
    await openLink(editRun, "/repo/apps/web/src/App.tsx");
    await clickFileTitle("apps/web/src/App.tsx");

    expect(openedFile()).toMatchObject({ relativePath: "src/App.tsx", revealLine: null });
    expect(state.toast).toHaveBeenCalledWith({
      type: "info",
      title: "Showing the current file; it may differ from this turn",
      description:
        "This turn's snapshot was taken in /repo/apps/web; the file opened from /worktrees/feature-b/apps/web.",
    });
  });
});
