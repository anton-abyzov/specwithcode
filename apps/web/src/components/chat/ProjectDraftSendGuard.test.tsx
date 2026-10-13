// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import type { Project } from "~/types";
import { useProjectDraftSendGuard } from "./ProjectDraftSendGuard";
const runtime = vi.hoisted(() => ({ legacy: false, toast: vi.fn() }));
vi.mock("~/hooks/useSettings", () => ({ useLegacySidebarEnabled: () => runtime.legacy }));
vi.mock("../ui/toast", () => ({ toastManager: { add: runtime.toast } }));
const openCoordinator = vi.fn().mockResolvedValue({ kind: "opened", threadId: "coordinator" });
const startTurn = vi.fn();
const saved = {
  prompt: "Preserve my work",
  images: [{ name: "diagram.png" }],
  files: [{ name: "scope.pdf" }],
  reviewComments: [{ text: "Fix this finding" }],
  terminalContexts: [{ output: "Important output" }],
  branch: "feature/saved",
  worktreePath: "/work/saved",
};
let draft = structuredClone(saved);
const project = {
  environmentId: EnvironmentId.make("m1"),
  id: ProjectId.make("project"),
  title: "Project",
  workspaceRoot: "/project",
} as Project;
let root: Root, container: HTMLDivElement;
function Form({
  isDraft = true,
  current = project,
  scratchRoot = "/scratch",
}: {
  isDraft?: boolean;
  current?: Project | null;
  scratchRoot?: string | null;
}) {
  const guard = useProjectDraftSendGuard(isDraft, current, scratchRoot, openCoordinator);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (guard.preventSend()) return;
        startTurn(draft);
        draft = {
          ...draft,
          prompt: "",
          images: [],
          files: [],
          reviewComments: [],
          terminalContexts: [],
        };
      }}
    >
      {guard.notice}
      <button type="submit">Send</button>
    </form>
  );
}
async function render(props: Parameters<typeof Form>[0] = {}) {
  await act(async () => root.render(<Form {...props} />));
}
async function send() {
  await act(async () =>
    container
      .querySelector('button[type="submit"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true })),
  );
}
beforeEach(() => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  runtime.legacy = false;
  runtime.toast.mockClear();
  openCoordinator.mockClear();
  startTurn.mockClear();
  draft = structuredClone(saved);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("blocks invested project draft Send before native creation and preserves every saved input", async () => {
  await render();
  await send();
  expect(startTurn).not.toHaveBeenCalled();
  expect(draft).toEqual(saved);
  expect(container.textContent).toContain("Project work starts in the coordinator");
  expect(container.textContent).toContain("attachments");
  expect(runtime.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Draft not sent" }));
  expect(openCoordinator).not.toHaveBeenCalled();
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[type="button"]')!.click(),
  );
  expect(openCoordinator).toHaveBeenCalledWith({ environmentId: "m1", projectId: "project" });
  expect(draft).toEqual(saved);
});
it.each(["server", "legacy", "scratch"])("keeps %s chat Send available", async (kind) => {
  runtime.legacy = kind === "legacy";
  await render({
    isDraft: kind !== "server",
    current: kind === "scratch" ? { ...project, workspaceRoot: "/scratch" } : project,
  });
  await send();
  expect(startTurn).toHaveBeenCalledOnce();
  expect(container.textContent).not.toContain("Project work starts");
  expect(openCoordinator).not.toHaveBeenCalled();
});
it("waits for unknown Scratch identity before allowing draft creation", async () => {
  await render({ scratchRoot: null });
  await send();
  expect(startTurn).not.toHaveBeenCalled();
  expect(draft).toEqual(saved);
  expect(container.textContent).toContain("Reconnect");
  expect(container.querySelector('button[type="button"]')).toBeNull();
  await render({ current: { ...project, workspaceRoot: "/scratch" } });
  await send();
  expect(startTurn).toHaveBeenCalledOnce();
});
