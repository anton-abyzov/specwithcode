// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
const state = vi.hoisted(() => ({
  fingerprint: vi.fn(),
  find: vi.fn(),
  toast: vi.fn(),
  waitForProject: vi.fn(),
  newThread: vi.fn(),
}));
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
  waitForProject: state.waitForProject,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "m4",
        label: "M4MAX",
        // This device: its own server on loopback.
        entry: {
          target: { _tag: "PrimaryConnectionTarget", httpBaseUrl: "http://127.0.0.1:3773" },
        },
        connection: { phase: "connected" },
        serverConfig: { environment: { capabilities: { projectLink: true } } },
      },
      { environmentId: "m1", label: "M1Max", connection: { phase: "disconnected" } },
    ],
  }),
}));
vi.mock("./useHandleNewThread", () => ({ useNewThreadHandler: () => state.newThread }));
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
  state.waitForProject.mockReset();
  state.newThread.mockReset().mockResolvedValue(null);
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

const created = (value: Record<string, unknown>) => ({
  _tag: "Success",
  value: { projectId: "p1", workspaceRoot: "/home/me/ec", ...value },
});
const toastWith = (fields: Record<string, unknown>) =>
  expect(state.toast).toHaveBeenCalledWith(expect.objectContaining(fields));

it("says the cause and the folder of a failed create, naming another machine", async () => {
  const failure = (reason: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error("Failed to create the project folder."), {
      projectCreateFailure: { reason, folder: "/srv/code", ...extra },
    });
  for (const [environmentId, error, description] of [
    [
      "m1",
      failure("parent_missing"),
      "The folder '/srv/code' does not exist on M1Max. Choose another folder.",
    ],
    [
      "m4",
      failure("permission_denied"),
      "You do not have permission to create a folder in '/srv/code' on this device. Choose another folder.",
    ],
    [
      "m1",
      failure("git_missing"),
      "Git is not installed on M1Max, so the project could not be made a repository. Install Git there, then try again.",
    ],
    [
      "m1",
      failure("git_init_failed", { detail: "fatal: cannot mkdir .git" }),
      "git init failed in '/srv/code' on M1Max: fatal: cannot mkdir .git",
    ],
    [
      "m4",
      failure("name_exhausted", { detail: "ec" }),
      `Every folder name for "ec" in '/srv/code' on this device is taken, up to 100. Choose another name or folder.`,
    ],
    // An older server: its own words, with the machine named.
    [
      "m1",
      new Error("The folder '/srv' does not exist on this machine."),
      "The folder '/srv' does not exist on M1Max.",
    ],
  ] as const) {
    state.toast.mockReset();
    state.fingerprint.mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(error) });
    await expect(
      create({ environmentId: environmentId as never, name: "ec", github: null }),
    ).resolves.toBe(false);
    toastWith({ title: "Could not create the project", description });
  }
});

it("gives the reason nothing was pushed, and the provider's reason for a failed publish", async () => {
  state.waitForProject.mockResolvedValue({ id: "p1", environmentId: "m4", title: "ec" });
  state.fingerprint
    .mockResolvedValueOnce(created({ commitError: "Git has no name or email on this machine." }))
    .mockResolvedValueOnce({
      _tag: "Success",
      value: { status: "remote_added", repository: { nameWithOwner: "me/ec" } },
    });
  await act(async () => {
    await create({ environmentId: "m4" as never, name: "ec", github: { account: "me" } });
  });
  toastWith({
    type: "warning",
    description:
      "me/ec is empty. The project has no first commit: Git has no name or email on this machine. Commit, then push from the Git menu.",
  });

  state.toast.mockReset();
  const refused = Object.assign(new Error("Source control repository operation failed"), {
    publishFailure: "not_signed_in",
    detail: "This machine is not signed in to GitHub.",
  });
  state.fingerprint
    .mockResolvedValueOnce(created({}))
    .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(refused) });
  await act(async () => {
    await create({ environmentId: "m1" as never, name: "ec", github: { account: "me" } });
  });
  toastWith({
    title: "Could not create the GitHub repository",
    description:
      "GitHub is not signed in on M1Max. Run gh auth login there, then publish again. Use Publish Repository in the Git menu to try again.",
  });
  expect(JSON.stringify(state.toast.mock.calls)).not.toContain("could not be completed");
});

it("names the machine on success and the existing project's own title", async () => {
  state.waitForProject.mockResolvedValue({ id: "p9", environmentId: "m4", title: "Existing app" });
  state.fingerprint.mockResolvedValueOnce(created({}));
  await act(async () => {
    await create({ environmentId: "m1" as never, name: "ec", github: null });
  });
  toastWith({ title: "Created ec", description: "/home/me/ec on M1Max" });

  state.toast.mockReset();
  state.fingerprint.mockResolvedValueOnce(created({ projectId: "p9", existing: true }));
  await act(async () => {
    await create({ environmentId: "m4" as never, name: "existing-app", github: null });
  });
  toastWith({ title: "Opened Existing app in its existing folder", description: "/home/me/ec" });
});

it("says the project exists and how to open it when the app cannot open it", async () => {
  state.waitForProject.mockResolvedValue({ id: "p1", environmentId: "m1", title: "ec" });
  state.newThread.mockImplementation(async (_ref, options) => {
    options?.onNotOpened?.("no_scratch");
    return null;
  });
  state.fingerprint.mockResolvedValueOnce(created({}));
  await act(async () => {
    await expect(create({ environmentId: "m1" as never, name: "ec", github: null })).resolves.toBe(
      true,
    );
  });
  toastWith({
    title: "ec is ready",
    description:
      "ec was created in /home/me/ec on M1Max. Open it from the sidebar, or choose it in Add project.",
  });
});
