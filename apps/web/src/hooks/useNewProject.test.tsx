// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({ fingerprint: vi.fn(), find: vi.fn(), toast: vi.fn() }));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (toast: unknown) => toast,
}));
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
import * as Cause from "effect/Cause";
import { useFindFolderCopies, useNewProject } from "./useNewProject";

let root: Root, container: HTMLDivElement, find: ReturnType<typeof useFindFolderCopies>;
let create: ReturnType<typeof useNewProject>;
function Harness() {
  find = useFindFolderCopies();
  create = useNewProject();
  return null;
}
beforeEach(async () => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.find.mockReset().mockResolvedValue([]);
  state.fingerprint.mockReset();
  state.toast.mockReset();
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

it("names the machine that refused a personal assistant because Aide is off there", async () => {
  // The server's own refusal, as an older client would show it.
  const refusal = Object.assign(
    new Error("The personal assistant is turned off. Turn it on in Settings > General."),
    { reason: "project_assistant_disabled" },
  );
  state.fingerprint.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(refusal) });
  await expect(
    create({ environmentId: "m4" as never, name: "Aide", kind: "personal", github: null }),
  ).resolves.toBe(false);
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      description:
        "The personal assistant is turned off on M4MAX. Turn it on in Settings > General while M4MAX is connected.",
    }),
  );
});

it("keeps any other refusal in the server's words", async () => {
  state.fingerprint.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(new Error("Another project already has this name.")),
  });
  await create({ environmentId: "m4" as never, name: "ec", github: null });
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ description: "Another project already has this name." }),
  );
});

it("says nothing was pushed when publishing only added the remote", async () => {
  const published = (status: string) => ({
    _tag: "Success",
    value: { status, repository: { nameWithOwner: "me/ec" } },
  });
  for (const [status, title] of [
    ["remote_added", "GitHub repository created, nothing pushed yet"],
    ["pushed", "Published to GitHub"],
  ] as const) {
    state.toast.mockReset();
    state.fingerprint
      .mockResolvedValueOnce({
        _tag: "Success",
        value: { projectId: "p1", workspaceRoot: "/home/me/ec" },
      })
      .mockResolvedValueOnce(published(status));
    // Opening the new project is mocked away; only the publish outcome matters here.
    await act(async () => {
      await create({
        environmentId: "m4" as never,
        name: "ec",
        github: { account: "me" },
      }).catch(() => undefined);
    });
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ title }));
  }
});
