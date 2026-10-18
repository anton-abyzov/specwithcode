// @vitest-environment jsdom
vi.mock("~/hooks/useProjectCoordinatorHandoff", () => ({
  useProjectCoordinatorHandoff: () => runtime.coordinator,
}));
// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { scopeProjectRef } from "@specweave-studio/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";

const runtime = vi.hoisted(() => ({
  legacy: true,
  coordinator: vi.fn(),
  environments: [] as any[],
  projects: [] as any[],
  permitted: new Set<string>(),
  scratch: vi.fn(),
  retry: vi.fn(),
}));
vi.mock("~/connection/catalog", () => ({ environmentCatalog: { retryNow: "retryNow" } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => runtime.retry }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: runtime.environments }),
}));
vi.mock("~/state/entities", () => ({ useProjects: () => runtime.projects }));
vi.mock("~/state/session", () => ({
  useEnvironmentsWithScope: () => runtime.permitted,
  readEnvironmentScope: (id: string) => runtime.permitted.has(id),
}));
vi.mock("~/hooks/useSettings", () => ({
  useLegacySidebarEnabled: () => runtime.legacy,
  useClientSettings: () => ({ mode: "directory", overrides: {} }),
}));
vi.mock("~/logicalProject", () => ({
  selectProjectGroupingSettings: () => ({}),
  deriveLogicalProjectKeyFromSettings: (project: { workspaceRoot: string }) =>
    project.workspaceRoot,
}));
vi.mock("~/hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    openScratchProject: runtime.scratch,
    scratchWorkspaceRootFor: (id: string) =>
      runtime.environments.find(
        (item) => item.environmentId === id && item.connection.phase === "connected",
      )
        ? `/scratch/${id}`
        : null,
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, ...props }: any) => <a href={to} {...props} />,
}));
import { DraftMachinePicker } from "./DraftMachinePicker";

const m4 = EnvironmentId.make("m4"),
  m1 = EnvironmentId.make("m1"),
  m3 = EnvironmentId.make("m3");
const projectId = ProjectId.make("m4-data"),
  draftId = DraftId.make("picker-draft");
let root: Root | undefined;
let container: HTMLDivElement;
const sendInFlightRef = { current: false };
const onPendingChange = vi.fn();
function props() {
  return { draftId, disabled: false, sendInFlightRef, onPendingChange };
}
async function render() {
  container = document.createElement("div");
  document.body.append(container);
  await act(async () => {
    root = createRoot(container);
    root.render(<DraftMachinePicker {...props()} />);
  });
}
function button(label: string) {
  const element = [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
    (node) => node.textContent?.includes(label),
  );
  if (!element) throw new Error(`Missing control ${label}: ${document.body.textContent}`);
  return element;
}
async function click(label: string) {
  await act(async () => {
    button(label).click();
  });
}
async function open() {
  await click("MachineM4");
}
beforeEach(() => {
  runtime.legacy = true;
  runtime.coordinator.mockReset().mockResolvedValue(true);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId("/m4/data", scopeProjectRef(m4, projectId), draftId, {});
  useComposerDraftStore.getState().setPrompt(draftId, "Do not lose this draft");
  runtime.environments = [m4, m1, m3].map((id) => ({
    environmentId: id,
    label: id.toUpperCase(),
    connection: { phase: "connected" },
  }));
  runtime.projects = [{ id: projectId, environmentId: m4, title: "m4", workspaceRoot: "/m4/data" }];
  runtime.permitted = new Set([m4, m1, m3]);
  runtime.scratch.mockReset();
  runtime.retry.mockReset().mockResolvedValue({ _tag: "Success" });
  onPendingChange.mockClear();
  sendInFlightRef.current = false;
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
});

it("shows a single primary non-Git machine and a connection path with one host shortcut", async () => {
  runtime.environments = runtime.environments.slice(0, 1);
  await render();
  const controls = document.querySelectorAll('button[data-composer-shortcut="composer.host"]');
  expect(controls).toHaveLength(1);
  expect(controls[0]!.getAttribute("aria-label")).toBe("Machine: M4");
  expect((controls[0] as HTMLButtonElement).disabled).toBe(false);
  await open();
  expect(document.querySelector('a[href="/settings/connections"]')).not.toBeNull();
  expect(runtime.scratch).not.toHaveBeenCalled();
});

it("requires an explicit No project choice when the destination lacks a matching project", async () => {
  useComposerDraftStore.getState().setDraftThreadContext(draftId, {
    envMode: "worktree",
    branch: "m4-only",
    worktreePath: "/m4/worktree",
    startFromOrigin: true,
  });
  runtime.scratch.mockResolvedValue({
    id: ProjectId.make("scratch-m1"),
    environmentId: m1,
    title: "Scratch",
    workspaceRoot: "/scratch/m1",
  });
  await render();
  await open();
  await click("M1Connected");
  expect(runtime.scratch).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
  await click("No project");
  expect(runtime.scratch).toHaveBeenCalledExactlyOnceWith(m1, "Could not switch machine");
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    environmentId: m1,
    environmentSelection: "manual",
    loadBalancedEnvironmentId: null,
    envMode: "local",
    branch: null,
    worktreePath: null,
    startFromOrigin: false,
  });
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Do not lose this draft",
  );
});

it("allows choosing a saved destination project without creating Scratch", async () => {
  const destination = {
    id: ProjectId.make("m1-project"),
    environmentId: m1,
    title: "Worker project",
    workspaceRoot: "/m1/other",
  };
  runtime.projects.push(destination);
  await render();
  await open();
  await click("M1Connected");
  await click("Worker project");
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    environmentId: m1,
    projectId: destination.id,
  });
  expect(runtime.scratch).not.toHaveBeenCalled();
});

it("keeps the matching logical project when explicitly choosing another machine", async () => {
  const destination = {
    id: ProjectId.make("matching-m1"),
    environmentId: m1,
    title: "Matching project",
    workspaceRoot: "/m4/data",
  };
  runtime.projects.push(destination);
  await render();
  await open();
  await click("M1Connected");
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    environmentId: m1,
    projectId: destination.id,
    environmentSelection: "manual",
  });
  expect(runtime.scratch).not.toHaveBeenCalled();
});

it("disables destination choices if the permission is revoked while the menu is open", async () => {
  await render();
  await open();
  await click("M1Connected");
  runtime.permitted = new Set([m4]);
  await act(async () => {
    root!.render(<DraftMachinePicker {...props()} />);
  });
  expect(button("No project").hasAttribute("data-disabled")).toBe(true);
  expect(document.querySelector('[role="status"]')?.textContent).toMatch(/Permission/);
  expect(runtime.scratch).not.toHaveBeenCalled();
});

it("refuses an already-started send even before the disabled prop updates", async () => {
  await render();
  await open();
  await click("M1Connected");
  sendInFlightRef.current = true;
  await click("No project");
  expect(runtime.scratch).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
});

it("does not select Auto during a send before the disabled prop updates", async () => {
  await render();
  const onAutoEnvironment = vi.fn();
  await act(async () =>
    root!.render(<DraftMachinePicker {...props()} onAutoEnvironment={onAutoEnvironment} />),
  );
  await open();
  sendInFlightRef.current = true;
  await click("Auto balance matching projects");
  expect(onAutoEnvironment).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentSelection).not.toBe(
    "auto",
  );
});

it("rechecks current machine-bound content before Auto despite a stale open menu", async () => {
  await render();
  const onAutoEnvironment = vi.fn();
  await act(async () =>
    root!.render(<DraftMachinePicker {...props()} onAutoEnvironment={onAutoEnvironment} />),
  );
  await open();
  await act(async () => {
    useComposerDraftStore.getState().addFiles(draftId, [
      {
        type: "file",
        id: "late",
        file: null,
        name: "late.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        uploadedAttachmentId: "source-upload",
        uploadEnvironmentId: m4,
      },
    ]);
    button("Auto balance matching projects").click();
  });
  expect(onAutoEnvironment).not.toHaveBeenCalled();
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.files).toHaveLength(1);
});

it("marks disconnected and permission-limited machines truthfully", async () => {
  runtime.environments[1].connection.phase = "available";
  runtime.permitted.delete(m3);
  await render();
  await open();
  expect(button("M1Not connected").hasAttribute("data-disabled")).toBe(true);
  expect(button("M3Permission to operate threads required").hasAttribute("data-disabled")).toBe(
    true,
  );
});

it("explains attachment blocking and leaves the draft untouched", async () => {
  useComposerDraftStore.getState().addFiles(draftId, [
    {
      type: "file",
      id: "file",
      file: null,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      uploadedAttachmentId: "source-upload",
      uploadEnvironmentId: m4,
    },
  ]);
  const before = useComposerDraftStore.getState().getComposerDraft(draftId);
  await render();
  await open();
  await click("M1Connected");
  expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/Remove attachments/);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)).toBe(before);
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
  expect(runtime.scratch).not.toHaveBeenCalled();
});

it("cancels a delayed Scratch retarget when the picker unmounts", async () => {
  let finish!: (project: any) => void;
  runtime.scratch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await open();
  await click("M1Connected");
  await click("No project");
  await act(async () => {
    root!.unmount();
  });
  root = undefined;
  await act(async () => {
    finish({ id: ProjectId.make("scratch-m1"), environmentId: m1, workspaceRoot: "/scratch/m1" });
  });
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
  expect(onPendingChange).toHaveBeenLastCalledWith(false);
});

it("hides archived destination projects and explains the missing project checkout", async () => {
  runtime.projects.push(
    {
      id: ProjectId.make("archived-m1"),
      environmentId: m1,
      title: "Archived fixture",
      workspaceRoot: "/m1/fixture",
      workspaceSettings: { archived: true },
    },
    {
      id: ProjectId.make("active-m1"),
      environmentId: m1,
      title: "Active project",
      workspaceRoot: "/m1/active",
    },
  );
  await render();
  await open();
  await click("M1Connected");
  expect(document.body.textContent).not.toContain("Archived fixture");
  expect(document.body.textContent).toContain("Active project");
  expect(document.body.textContent).toContain("No active checkout of m4 is saved on M1");
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
});

it("skips an archived logical match and selects its active sibling", async () => {
  runtime.projects.push(
    {
      id: ProjectId.make("archived-match"),
      environmentId: m1,
      title: "Archived match",
      workspaceRoot: "/m4/data",
      workspaceSettings: { archived: true },
    },
    {
      id: ProjectId.make("active-match"),
      environmentId: m1,
      title: "Active match",
      workspaceRoot: "/m4/data",
    },
  );
  await render();
  await open();
  await click("M1Connected");
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.projectId).toBe("active-match");
});

it("refuses a project archived after selection starts and preserves the prompt", async () => {
  const project = {
    id: ProjectId.make("archive-during-select"),
    environmentId: m1,
    title: "Destination",
    workspaceRoot: "/m1/destination",
    workspaceSettings: { archived: false },
  };
  runtime.projects.push(project);
  await render();
  await open();
  await click("M1Connected");
  await act(async () => {
    button("Destination").click();
    project.workspaceSettings.archived = true;
  });
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Do not lose this draft",
  );
  expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/archived/i);
});

it.each(["resolved", "catalog"])(
  "rejects archived Scratch from the %s after resolution",
  async (source) => {
    let finish!: (project: any) => void;
    runtime.scratch.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await open();
    await click("M1Connected");
    await click("No project");
    const scratch = {
      id: ProjectId.make("scratch-m1"),
      environmentId: m1,
      workspaceRoot: "/scratch/m1",
      workspaceSettings: { archived: source === "resolved" },
    };
    if (source === "catalog")
      runtime.projects.push({ ...scratch, workspaceSettings: { archived: true } });
    await act(async () => finish(scratch));
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Do not lose this draft",
    );
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(/archived/i);
  },
);

it("opens the coordinator for a modern named project and preserves the independent draft", async () => {
  runtime.legacy = false;
  runtime.projects.push({
    id: ProjectId.make("named-m1"),
    environmentId: m1,
    title: "Named project",
    workspaceRoot: "/named",
  });
  const before = useComposerDraftStore.getState().getDraftSession(draftId);
  await render();
  await open();
  await click("M1Connected");
  await click("Named project");
  expect(runtime.coordinator).toHaveBeenCalledWith(scopeProjectRef(m1, ProjectId.make("named-m1")));
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBe(before);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Do not lose this draft",
  );
});

it("says why a machine is unreachable and retries it instead of selecting it", async () => {
  runtime.environments[1] = {
    environmentId: m1,
    label: "M1",
    connection: { phase: "reconnecting", error: "M1 could not establish a WebSocket connection." },
  };
  runtime.environments[2] = {
    environmentId: m3,
    label: "M3",
    connection: { phase: "connecting", error: null },
  };
  await render();
  await open();
  const m1Row = button("M1Can't reach");
  expect(m1Row.textContent).toContain("M1 could not establish a WebSocket connection.");
  expect(m1Row.textContent).toContain("Retry");
  expect(m1Row.hasAttribute("data-disabled")).toBe(false);
  expect(button("M3Connecting…").hasAttribute("data-disabled")).toBe(true);
  await click("M1Can't reach");
  expect(runtime.retry).toHaveBeenCalledExactlyOnceWith(m1);
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
  expect(runtime.scratch).not.toHaveBeenCalled();
});

it("shows on the closed picker when the chosen machine can't be reached", async () => {
  runtime.environments[0] = {
    environmentId: m4,
    label: "M4",
    connection: { phase: "error", error: "Sign in again." },
  };
  await render();
  const control = document.querySelector('button[data-composer-shortcut="composer.host"]')!;
  expect(control.getAttribute("aria-label")).toBe("Machine: M4, Connection failed");
  expect(control.querySelector("[data-draft-machine-unreachable]")?.textContent).toBe(
    "Can't reach",
  );
});
