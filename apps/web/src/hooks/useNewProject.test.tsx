// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ fingerprint: vi.fn(), find: vi.fn() }));
vi.mock("../studio/projectLink", () => ({ projectLink: { fingerprint: "fingerprint" } }));
vi.mock("../studio/folderLinkSuggestion", () => ({ findFolderCopies: state.find }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.fingerprint }));
vi.mock("../state/projects", () => ({ projectEnvironment: { createNew: "create" } }));
vi.mock("../state/sourceControl", () => ({ sourceControlEnvironment: {} }));
vi.mock("../state/entities", () => ({
  useProjects: () => [{ id: "ec" }],
  waitForProject: vi.fn(),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "m4",
        label: "M4MAX",
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: { projectLink: true } } },
      },
      { environmentId: "m1", label: "M1Max", connection: { phase: "disconnected" } },
    ],
  }),
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
import { useFindFolderCopies } from "./useNewProject";

let root: Root, container: HTMLDivElement, find: ReturnType<typeof useFindFolderCopies>;
function Harness() {
  find = useFindFolderCopies();
  return null;
}
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.find.mockReset().mockResolvedValue([]);
  state.fingerprint.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("asks each machine for fingerprints, reporting which ones can link", async () => {
  const folder = { environmentId: "m3" as never, workspaceRoot: "/Users/a/ec", title: "ec" };
  await find(folder);
  const call = state.find.mock.calls[0]![0];
  expect(call.folder).toBe(folder);
  expect(call.projects).toEqual([{ id: "ec" }]);
  expect(call.machines).toEqual([
    { environmentId: "m4", label: "M4MAX", connected: true, supportsLink: true },
    { environmentId: "m1", label: "M1Max", connected: false, supportsLink: undefined },
  ]);
  const fingerprint = { root: "folder", repositories: [], skippedLinks: 0, truncated: false };
  state.fingerprint.mockResolvedValueOnce({
    _tag: "Success",
    value: { workspaceRoot: "/Users/a/ec", fingerprint },
  });
  await expect(call.read("m3", { workspaceRoot: "/Users/a/ec" })).resolves.toBe(fingerprint);
  expect(state.fingerprint).toHaveBeenCalledWith({
    environmentId: "m3",
    input: { workspaceRoot: "/Users/a/ec" },
  });
  state.fingerprint.mockResolvedValueOnce({ _tag: "Failure", error: new Error("old server") });
  await expect(call.read("m4", { projectId: "ec" })).resolves.toBeNull();
});
