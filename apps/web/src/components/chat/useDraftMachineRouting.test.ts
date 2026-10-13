// @vitest-environment jsdom
import { scopeProjectRef, scopeThreadRef } from "@specweave-studio/client-runtime/environment";
import {
  DEFAULT_PROJECT_WORKSPACE_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

const runtime = vi.hoisted(() => ({ permitted: new Set<string>(), toast: vi.fn() }));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: (id: string) => runtime.permitted.has(id),
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: runtime.toast } }));
import { useDraftMachineRouting } from "./useDraftMachineRouting";

type Input = Parameters<typeof useDraftMachineRouting>[0];
type Routing = ReturnType<typeof useDraftMachineRouting>;
const m4 = EnvironmentId.make("m4"),
  m1 = EnvironmentId.make("m1"),
  m3 = EnvironmentId.make("m3");
const p4 = ProjectId.make("scratch-m4"),
  p1 = ProjectId.make("scratch-m1");
const draftId = DraftId.make("routing-draft");
const boundFields = [
  "images",
  "files",
  "persistedAttachments",
  "terminalContexts",
  "previewAnnotations",
  "reviewComments",
  "threadContexts",
] as const;
let root: Root | undefined, container: HTMLElement, input: Input, routing: Routing;
let finish: (project: any) => void;
const refresh = vi.fn(),
  scratch = vi.fn();
const destination = { environmentId: m1, id: p1, title: "Scratch", workspaceRoot: "/scratch/m1" };
function Harness(props: Input) {
  routing = useDraftMachineRouting(props);
  return null;
}
async function render(next: Partial<Input> = {}) {
  input = { ...input, ...next };
  await act(async () => {
    if (!root) {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    }
    root.render(createElement(Harness, input));
  });
}
function addBoundContent(field: (typeof boundFields)[number]) {
  const store = useComposerDraftStore.getState();
  if (field === "files") {
    store.addFiles(draftId, [
      {
        type: "file",
        id: "owned-file",
        file: null,
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        uploadedAttachmentId: "source-upload",
        uploadEnvironmentId: m4,
      },
    ]);
  } else {
    const composer = store.getComposerDraft(draftId)!;
    useComposerDraftStore.setState({
      draftsByThreadKey: {
        ...store.draftsByThreadKey,
        [draftId]: { ...composer, [field]: [{ fixture: "source-machine-reference" }] },
      },
    });
  }
}
async function resolveScratch(project = destination) {
  await act(async () => {
    finish(project);
  });
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  const store = useComposerDraftStore.getState();
  store.setLogicalProjectDraftThreadId("/scratch/m4", scopeProjectRef(m4, p4), draftId, {
    environmentSelection: "manual",
    branch: "explicit-branch",
    worktreePath: "/m4/worktree",
    envMode: "worktree",
  });
  store.setPrompt(draftId, "Keep the prompt");
  runtime.permitted = new Set([m4, m1, m3]);
  runtime.toast.mockReset();
  refresh.mockReset();
  scratch.mockReset();
  scratch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  input = {
    draftId,
    draftThread: store.getDraftSession(draftId),
    envLocked: false,
    sendInFlightRef: { current: false },
    environments: [m4, m1, m3].map((environmentId) => ({
      environmentId,
      connection: { phase: "connected" },
    })) as unknown as Input["environments"],
    allProjects: [
      { id: p4, environmentId: m4, title: "Scratch", workspaceRoot: "/scratch/m4" },
      destination,
    ] as unknown as Input["allProjects"],
    logicalProjectEnvironments: [
      { environmentId: m4, projectId: p4 },
      { environmentId: m1, projectId: null },
      { environmentId: m3, projectId: null },
    ] as unknown as Input["logicalProjectEnvironments"],
    projectGroupingSettings: {
      sidebarProjectGroupingMode: "separate",
      sidebarProjectGroupingOverrides: {},
    },
    activeProjectIsScratch: true,
    activeProjectKey: "m4/scratch",
    needsLoadBalancing: false,
    loadBalancing: { refresh, pending: true, environmentId: null, failed: false },
    openScratchProject: scratch,
  };
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});

it("Auto updates the current unsent draft and retains its prompt", async () => {
  await render();
  await act(async () => routing.onAutoEnvironment());
  expect(refresh).toHaveBeenCalledWith([m4, m1, m3]);
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    environmentSelection: "auto",
    branch: null,
    worktreePath: null,
  });
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Keep the prompt",
  );
});

it.each([
  "sending",
  "picker-pending",
  "legacy-pending",
  "promoted",
  "new-workspace",
  "away-and-back",
  "missing",
  "route-changed",
  "route-locked",
  "new-send-ref",
])("Auto rejects %s through the actual callback", async (kind) => {
  await render();
  const oldAuto = routing.onAutoEnvironment,
    store = useComposerDraftStore.getState();
  if (kind === "sending") (input.sendInFlightRef as { current: boolean }).current = true;
  if (kind === "picker-pending") await act(async () => routing.onDraftMachinePendingChange(true));
  if (kind === "legacy-pending") await act(async () => routing.onEnvironmentChange(m1));
  if (kind === "promoted")
    store.markDraftThreadPromoting(draftId, scopeThreadRef(m4, ThreadId.make("sent")));
  if (kind === "new-workspace") store.setDraftThreadContext(draftId, { branch: "new-choice" });
  if (kind === "away-and-back") {
    store.setDraftThreadContext(draftId, { projectRef: scopeProjectRef(m1, p1) });
    store.setDraftThreadContext(draftId, { projectRef: scopeProjectRef(m4, p4) });
  }
  if (kind === "missing") store.clearDraftThread(draftId);
  if (kind === "route-changed")
    await render({ draftId: DraftId.make("new-route"), draftThread: null });
  if (kind === "route-locked") await render({ envLocked: true });
  if (kind === "new-send-ref") await render({ sendInFlightRef: { current: true } });
  const before = store.getDraftSession(draftId);
  await act(async () => oldAuto());
  expect(refresh).not.toHaveBeenCalled();
  expect(store.getDraftSession(draftId)).toBe(before);
});

it.each(boundFields)("Auto preserves and blocks current %s", async (field) => {
  await render();
  addBoundContent(field);
  const before = useComposerDraftStore.getState().getComposerDraft(draftId);
  await act(async () => routing.onAutoEnvironment());
  expect(refresh).not.toHaveBeenCalled();
  expect(runtime.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringContaining("linked context") }),
  );
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBe(before);
});

it("Auto does not erase manual choices when no destination admits operations", async () => {
  runtime.permitted.clear();
  await render();
  const before = useComposerDraftStore.getState().getDraftSession(draftId);
  await act(async () => routing.onAutoEnvironment());
  expect(refresh).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBe(before);
});

it.each(boundFields)("legacy cycle rechecks late %s after Scratch resolves", async (field) => {
  await render();
  await act(async () => routing.onEnvironmentChange(m1));
  expect(scratch).toHaveBeenCalledOnce();
  addBoundContent(field);
  const store = useComposerDraftStore.getState(),
    before = store.getComposerDraft(draftId);
  await resolveScratch();
  expect(store.getDraftSession(draftId)?.environmentId).toBe(m4);
  expect(store.getComposerDraft(draftId)).toBe(before);
  expect(runtime.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringContaining("linked context") }),
  );
  expect(routing.isEnvironmentChanging).toBe(false);
  if (field === "files")
    expect(store.getComposerDraft(draftId)?.files[0]).toMatchObject({
      uploadedAttachmentId: "source-upload",
      uploadEnvironmentId: m4,
      file: null,
    });
});

it.each([
  "sending",
  "picker-pending",
  "promoted",
  "new-workspace",
  "away-and-back",
  "missing",
  "route-changed",
  "route-locked",
  "new-send-ref",
  "permission-revoked",
  "offline",
  "removed-machine",
  "removed-target",
  "unmounted",
])("legacy cycle rejects %s while Scratch resolves", async (kind) => {
  await render();
  await act(async () => routing.onEnvironmentChange(m1));
  const store = useComposerDraftStore.getState();
  if (kind === "sending") (input.sendInFlightRef as { current: boolean }).current = true;
  if (kind === "picker-pending") await act(async () => routing.onDraftMachinePendingChange(true));
  if (kind === "promoted")
    store.markDraftThreadPromoting(draftId, scopeThreadRef(m4, ThreadId.make("sent")));
  if (kind === "new-workspace")
    store.setDraftThreadContext(draftId, { worktreePath: "/new-worktree" });
  if (kind === "away-and-back") {
    store.setDraftThreadContext(draftId, { projectRef: scopeProjectRef(m1, p1) });
    store.setDraftThreadContext(draftId, { projectRef: scopeProjectRef(m4, p4) });
  }
  if (kind === "missing") store.clearDraftThread(draftId);
  if (kind === "route-changed")
    await render({ draftId: DraftId.make("new-route"), draftThread: null });
  if (kind === "route-locked") await render({ envLocked: true });
  if (kind === "new-send-ref") await render({ sendInFlightRef: { current: true } });
  if (kind === "permission-revoked") runtime.permitted.delete(m1);
  if (kind === "offline")
    await render({
      environments: input.environments.map((item) =>
        item.environmentId === m1
          ? { ...item, connection: { ...item.connection, phase: "offline" } }
          : item,
      ),
    });
  if (kind === "removed-machine")
    await render({ environments: input.environments.filter((item) => item.environmentId !== m1) });
  if (kind === "removed-target")
    await render({
      logicalProjectEnvironments: input.logicalProjectEnvironments.filter(
        (item) => item.environmentId !== m1,
      ),
    });
  if (kind === "unmounted") {
    await act(async () => root!.unmount());
    root = undefined;
  }
  const before = store.getDraftSession(draftId);
  await resolveScratch();
  expect(store.getDraftSession(draftId)).toBe(before);
});

it.each([
  { activeProjectIsScratch: true, existingScratch: false },
  { activeProjectIsScratch: false, existingScratch: false },
  { activeProjectIsScratch: true, existingScratch: true },
])(
  "legacy No project cycle uses local mode and preserves text (%j)",
  async ({ activeProjectIsScratch, existingScratch }) => {
    const store = useComposerDraftStore.getState();
    store.setDraftThreadContext(draftId, { startFromOrigin: true });
    await render({
      activeProjectIsScratch,
      draftThread: store.getDraftSession(draftId),
      ...(existingScratch
        ? {
            logicalProjectEnvironments: input.logicalProjectEnvironments.map((item) =>
              item.environmentId === m1 ? { ...item, projectId: p1 } : item,
            ),
          }
        : {}),
    });
    await act(async () => routing.onEnvironmentChange(m1));
    useComposerDraftStore.getState().setPrompt(draftId, "Newer text");
    if (!existingScratch) await resolveScratch();
    else expect(scratch).not.toHaveBeenCalled();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      environmentId: m1,
      projectId: p1,
      environmentSelection: "manual",
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
    });
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe("Newer text");
    expect(routing.isEnvironmentChanging).toBe(false);
  },
);

it("a newer legacy switch wins when the earlier Scratch request resolves last", async () => {
  const resolves = new Map<string, (project: any) => void>();
  scratch.mockImplementation((id: string) => new Promise((resolve) => resolves.set(id, resolve)));
  await render();
  await act(async () => routing.onEnvironmentChange(m1));
  await act(async () => routing.onEnvironmentChange(m3));
  await act(async () =>
    resolves.get(m3)!({ ...destination, environmentId: m3, id: ProjectId.make("scratch-m3") }),
  );
  await act(async () => resolves.get(m1)!(destination));
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m3);
});

it.each([
  "sending",
  "picker-pending",
  "legacy-pending",
  "promoted",
  "attachments",
  "permission-revoked",
  "offline",
  "removed-project",
  "archived-project",
])("delayed Auto completion rejects %s", async (kind) => {
  const logicalProjectEnvironments = input.logicalProjectEnvironments.map((item) =>
    item.environmentId === m1 ? { ...item, projectId: p1 } : item,
  );
  await render({ needsLoadBalancing: true, logicalProjectEnvironments });
  const store = useComposerDraftStore.getState();
  if (kind === "sending") (input.sendInFlightRef as { current: boolean }).current = true;
  if (kind === "picker-pending") await act(async () => routing.onDraftMachinePendingChange(true));
  if (kind === "legacy-pending") {
    await render({
      logicalProjectEnvironments: input.logicalProjectEnvironments.map((item) =>
        item.environmentId === m1 ? { ...item, projectId: null } : item,
      ),
    });
    await act(async () => routing.onEnvironmentChange(m1));
  }
  if (kind === "promoted")
    store.markDraftThreadPromoting(draftId, scopeThreadRef(m4, ThreadId.make("sent")));
  if (kind === "attachments") addBoundContent("terminalContexts");
  if (kind === "permission-revoked") runtime.permitted.delete(m1);
  if (kind === "offline")
    input = {
      ...input,
      environments: input.environments.map((item) =>
        item.environmentId === m1
          ? { ...item, connection: { ...item.connection, phase: "offline" } }
          : item,
      ),
    };
  if (kind === "removed-project")
    input = { ...input, allProjects: input.allProjects.filter((item) => item.id !== p1) };
  if (kind === "archived-project")
    input = {
      ...input,
      allProjects: input.allProjects.map((project) =>
        project.id === p1
          ? { ...project, workspaceSettings: { ...project.workspaceSettings, archived: true } }
          : project,
      ),
    } as Input;
  const before = store.getDraftSession(draftId);
  await render({
    draftThread: before,
    loadBalancing: { ...input.loadBalancing, pending: false, environmentId: m1 },
  });
  expect(store.getDraftSession(draftId)).toBe(before);
});

it("delayed Auto completion admits a connected permitted destination project", async () => {
  await render({
    needsLoadBalancing: true,
    logicalProjectEnvironments: input.logicalProjectEnvironments.map((item) =>
      item.environmentId === m1 ? { ...item, projectId: p1 } : item,
    ),
    loadBalancing: { ...input.loadBalancing, pending: false, environmentId: m1 },
  });
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    environmentId: m1,
    projectId: p1,
    environmentSelection: "auto",
    loadBalancedEnvironmentId: m1,
  });
});

it("Auto excludes archived destinations even with a stale machine list", async () => {
  await render({
    allProjects: input.allProjects.map((project) =>
      project.id === p1
        ? {
            ...project,
            workspaceSettings: {
              ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
              ...project.workspaceSettings,
              archived: true,
            },
          }
        : project,
    ) as Input["allProjects"],
    logicalProjectEnvironments: input.logicalProjectEnvironments
      .filter((option) => option.environmentId === m1)
      .map((option) => ({ ...option, projectId: p1 })),
  });
  const before = useComposerDraftStore.getState().getDraftSession(draftId);
  await act(async () => routing.onAutoEnvironment());
  expect(refresh).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBe(before);
});

it("keyboard routing rejects an archived project even with a stale machine list", async () => {
  await render({
    allProjects: input.allProjects.map((project) =>
      project.id === p1
        ? {
            ...project,
            workspaceSettings: {
              ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
              ...project.workspaceSettings,
              archived: true,
            },
          }
        : project,
    ) as Input["allProjects"],
    logicalProjectEnvironments: input.logicalProjectEnvironments
      .filter((option) => option.environmentId === m1)
      .map((option) => ({ ...option, projectId: p1 })),
  });
  await act(async () => routing.onEnvironmentChange(m1));
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Keep the prompt",
  );
  expect(runtime.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringMatching(/archived/i) }),
  );
});

it.each(["resolved", "catalog"])(
  "keyboard routing rejects archived Scratch from the %s after resolution",
  async (source) => {
    await render();
    await act(async () => routing.onEnvironmentChange(m1));
    if (source === "catalog")
      await render({
        allProjects: input.allProjects.map((project) =>
          project.id === p1
            ? {
                ...project,
                workspaceSettings: {
                  ...DEFAULT_PROJECT_WORKSPACE_SETTINGS,
                  ...project.workspaceSettings,
                  archived: true,
                },
              }
            : project,
        ),
      });
    await resolveScratch({
      ...destination,
      workspaceSettings: { archived: source === "resolved" },
    } as typeof destination);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Keep the prompt",
    );
    expect(runtime.toast).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringMatching(/archived/i) }),
    );
  },
);
