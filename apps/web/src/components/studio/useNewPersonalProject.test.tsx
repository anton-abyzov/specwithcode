// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";
const state = vi.hoisted(() => ({
  create: vi.fn(),
  publish: vi.fn(),
  navigate: vi.fn(),
  thread: vi.fn(),
  toast: vi.fn(),
  wait: vi.fn(),
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (v: unknown) => v,
  toastManager: { add: state.toast },
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { createNew: "create" } }));
vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: { publishRepository: "publish" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (key: "create" | "publish") => state[key],
}));
vi.mock("../../state/entities", () => ({ waitForProject: state.wait }));
vi.mock("../../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => state.thread }));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => ({
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => state.navigate }));
import { useNewProject } from "../../hooks/useNewProject";
let root: Root, container: HTMLDivElement, create: ReturnType<typeof useNewProject>;
function Harness() {
  create = useNewProject();
  return null;
}
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  for (const fn of Object.values(state)) fn.mockReset();
  state.create.mockResolvedValue({
    _tag: "Success",
    value: { projectId: "p", workspaceRoot: "/managed/personal/p" },
  });
  state.thread.mockResolvedValue(undefined);
  state.wait.mockResolvedValue({
    id: "p",
    environmentId: "remote",
    workspaceRoot: "/managed/personal/p",
    repositoryIdentity: null,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
it("creates Personal on the explicitly selected host and opens its coordinator without publishing or starting a worker", async () => {
  await act(async () => {
    await create({
      environmentId: EnvironmentId.make("remote"),
      name: "Personal",
      kind: "personal",
      github: { account: "unused" },
    });
  });
  expect(state.create).toHaveBeenCalledWith({
    environmentId: "remote",
    input: { name: "Personal", kind: "personal" },
  });
  expect(state.publish).not.toHaveBeenCalled();
  expect(state.thread).not.toHaveBeenCalled();
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/projects/$projectKey",
    params: { projectKey: expect.any(String) },
  });
});
it("keeps ordinary code creation and its thread draft available", async () => {
  await act(async () => {
    await create({ environmentId: EnvironmentId.make("remote"), name: "Code", github: null });
  });
  expect(state.create.mock.calls[0]![0].input.kind).toBe("code");
  expect(state.thread).toHaveBeenCalledOnce();
  expect(state.navigate).not.toHaveBeenCalled();
});
