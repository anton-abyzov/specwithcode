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
  projects: [] as any[],
  toast: vi.fn(),
  change: null as null | ((value: string) => void),
}));
vi.mock("~/state/entities", () => ({
  useProjects: () => runtime.projects,
  useThreadShells: () => [],
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "m4", label: "M4", connection: { phase: "connected" } },
      { environmentId: "m1", label: "M1", connection: { phase: "connected" } },
    ],
  }),
  usePrimaryEnvironmentId: () => "m4",
}));
vi.mock("~/state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("~/keybindings", () => ({ shortcutLabelForCommand: () => null }));
vi.mock("~/hooks/useSettings", () => ({
  useLegacySidebarEnabled: () => runtime.legacy,
  useClientSettings: (select: any) =>
    select({
      sidebarProjectGroupingMode: "repository",
      sidebarProjectGroupingOverrides: {},
      sidebarProjectSortOrder: "alphabetical",
    }),
}));
vi.mock("~/hooks/useScratchProject", () => ({
  useScratchProject: () => ({
    scratchEnvironmentId: () => "m4",
    scratchWorkspaceRootFor: () => "/scratch",
    openScratchProject: vi.fn(),
  }),
}));
vi.mock("../Sidebar.logic", () => ({ sortLogicalProjectsForSidebar: (groups: any) => groups }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("../ProjectEnvironmentBadge", () => ({ ProjectEnvironmentBadge: () => null }));
vi.mock("../ui/toast", () => ({ toastManager: { add: runtime.toast } }));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: any) => children,
  MenuTrigger: ({ children }: any) => children,
  MenuPopup: ({ children }: any) => <div>{children}</div>,
  MenuItem: ({ children }: any) => <div>{children}</div>,
  MenuSeparator: () => null,
  MenuRadioGroup: ({ children, onValueChange }: any) => {
    runtime.change = onValueChange;
    return <div>{children}</div>;
  },
  MenuRadioItem: ({ children, value, disabled }: any) => (
    <button disabled={disabled} onClick={() => runtime.change?.(value)}>
      {children}
    </button>
  ),
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: any) => children,
  TooltipTrigger: ({ children }: any) => children,
  TooltipPopup: () => null,
}));
import { DraftHeroHeadline } from "./DraftHeroHeadline";
const m4 = EnvironmentId.make("m4"),
  m1 = EnvironmentId.make("m1"),
  p4 = ProjectId.make("source"),
  draftId = DraftId.make("hero-draft");
let root: Root, container: HTMLDivElement;
function project(
  environmentId: EnvironmentId,
  id: string,
  title: string,
  archived = false,
  canonicalKey = id,
) {
  return {
    environmentId,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: { canonicalKey, rootPath: `/work/${id}` },
    workspaceSettings: { archived },
    createdAt: "2026-10-12",
    updatedAt: "2026-10-12",
  };
}
async function render() {
  await act(async () =>
    root.render(
      <DraftHeroHeadline
        draftId={draftId}
        activeProjectRef={scopeProjectRef(m4, p4)}
        activeProjectTitle="Source"
      />,
    ),
  );
}
beforeEach(() => {
  runtime.legacy = true;
  runtime.coordinator.mockReset().mockResolvedValue(true);
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId("source", scopeProjectRef(m4, p4), draftId, {});
  useComposerDraftStore.getState().setPrompt(draftId, "Keep this prompt");
  runtime.projects = [project(m4, "source", "Source")];
  runtime.toast.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("hides archived projects and chooses an active sibling instead of the archived preferred host", async () => {
  runtime.projects.push(
    project(m4, "old", "Shared", true, "shared"),
    project(m1, "active", "Shared", false, "shared"),
    project(m1, "archived", "Archived fixture", true),
  );
  await render();
  expect(document.body.textContent).not.toContain("Archived fixture");
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((node) => node.textContent === "Shared")!
      .click(),
  );
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    environmentId: m1,
    projectId: "active",
  });
});
it("refuses a stale project choice after it is archived and retains draft text", async () => {
  const target = project(m1, "target", "Target");
  runtime.projects.push(target);
  await render();
  const previousChange = runtime.change!;
  runtime.projects = runtime.projects.map((p) =>
    p.id === "target" ? { ...p, workspaceSettings: { archived: true } } : p,
  );
  await render();
  await act(async () => previousChange("target"));
  expect(useComposerDraftStore.getState().getDraftSession(draftId)?.environmentId).toBe(m4);
  expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
    "Keep this prompt",
  );
  expect(runtime.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: expect.stringMatching(/archived/) }),
  );
});
it("keeps an archived current project in the heading without offering it as a destination", async () => {
  runtime.projects[0].workspaceSettings.archived = true;
  await render();
  expect(container.querySelector("h1")?.getAttribute("aria-label")).toBe(
    "What should we build in Source?",
  );
  expect(
    [...container.querySelectorAll("button")].filter((node) => node.textContent === "Source"),
  ).toHaveLength(1);
});

it("offers only active project rows and keeps No project outside the dropdown", async () => {
  const check = project(m1, "check", "Acceptance check");
  runtime.projects.push(
    { ...check, workspaceSettings: { archived: false, origin: "automated" } },
    { ...project(m4, "scratch", "Scratch"), workspaceRoot: "/scratch" },
    project(m1, "app", "App"),
  );
  await render();
  const rows = [...container.querySelectorAll("button")].map((node) => node.textContent);
  expect(rows).not.toContain("No project");
  expect(rows).toContain("App");
  expect(document.body.textContent).not.toContain("Acceptance check");
  expect(document.body.textContent).not.toContain("Scratch");
});

it.each([
  ["archived", { archived: true }, "Archived project, not available here"],
  ["automated", { archived: false, origin: "automated" }, "Automated project, not available here"],
])("shows an %s current project as a row that cannot be chosen", async (_, settings, label) => {
  runtime.projects[0].workspaceSettings = settings;
  runtime.projects.push(project(m1, "app", "App"));
  await render();
  const current = [...container.querySelectorAll("button")].find(
    (node) => node.textContent === `Source${label}`,
  );
  expect(current?.disabled).toBe(true);
  expect(
    [...container.querySelectorAll("button")].filter(
      (node) => !node.disabled && node.textContent?.startsWith("Source"),
    ),
  ).toEqual([]);
});

it("can leave an archived current checkout for the active member of the same logical project", async () => {
  runtime.projects[0].workspaceSettings.archived = true;
  runtime.projects.push(project(m1, "other-source", "Source", false, "source"));
  await render();
  await act(async () => runtime.change!("source"));
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
    environmentId: m1,
    projectId: "other-source",
  });
});

it("opens a modern project's coordinator without retargeting or clearing the existing draft", async () => {
  runtime.legacy = false;
  runtime.projects.push(project(m1, "target", "Destination"));
  const before = useComposerDraftStore.getState().getDraftSession(draftId);
  await render();
  await act(async () =>
    [...container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Destination"))!
      .click(),
  );
  expect(runtime.coordinator).toHaveBeenCalledWith(scopeProjectRef(m1, ProjectId.make("target")));
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).toBe(before);
});
