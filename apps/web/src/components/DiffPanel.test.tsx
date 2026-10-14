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
    diffFilesCollapsed: false,
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
      data: state.checkpointError ? undefined : { diff: "" },
      isPending: false,
      error: state.checkpointError,
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
vi.mock("./diffs/useCodeViewFileReveal", () => ({ useCodeViewFileReveal: () => state.command }));
vi.mock("./diffs/useReviewFilePatches", () => ({
  useReviewFilePatches: () => ({
    scope: "fixture",
    isPending: false,
    fileStates: new Map(),
    retry: state.command,
    requestFile: state.command,
    readyFilePaths: new Set(),
    renderableFiles: [],
    settledFileCount: 0,
    loadNextFiles: state.command,
  }),
}));
// The component, route resolution and per-thread selection store are real. Only
// the rendering engine and I/O hooks are substituted; no provider or server runs.
vi.mock("./diffs/AnnotatableCodeView", () => ({ AnnotatableCodeView: () => null }));

import DiffPanel from "./DiffPanel";
import { EmbeddedThreadDiffPanel } from "./chat/EmbeddedThreadDiffPanel";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";

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
      summaries: [{ runId, checkpointTurnCount: 1, completedAt: "2026-10-14T12:00:00Z" }],
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
  state.command.mockClear();
  state.refresh.mockClear();
  clearReads();
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
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
