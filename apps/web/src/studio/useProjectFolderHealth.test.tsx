// @vitest-environment jsdom
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { ProjectFolderCheck } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  phase: "connected",
  check: vi.fn<(input: unknown) => Promise<unknown>>(),
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.check }));
vi.mock("../state/projects", () => ({ projectEnvironment: { folderCheck: {} } }));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({ connection: { phase: state.phase } }),
}));

import {
  projectFolderHealth,
  RECHECK_AFTER_MS,
  resetProjectFolderChecksForTests,
  useProjectFolderHealth,
  type ProjectFolderHealth,
} from "./useProjectFolderHealth";

const folderCheck = (overrides: Partial<ProjectFolderCheck> = {}) =>
  ({
    projectId: "project",
    currentRoot: "/w/atlas",
    targetRoot: "/w/atlas",
    unchanged: true,
    targetExists: true,
    layout: {
      kind: "single",
      rootIsRepository: true,
      repositories: ["."],
      repositoryCount: 1,
      truncated: false,
    },
    ...overrides,
  }) as ProjectFolderCheck;
const project = (workspaceRoot = "/w/atlas") =>
  ({ environmentId: "host", id: "project", workspaceRoot }) as unknown as EnvironmentProject;

let renderer: ReactTestRenderer | null = null;
function Probe(props: { project: EnvironmentProject }) {
  return useProjectFolderHealth(props.project);
}
const health = () => renderer?.toJSON() as ProjectFolderHealth | null;
async function render(target = project()) {
  await act(async () => {
    if (renderer) renderer.update(<Probe project={target} />);
    else renderer = create(<Probe project={target} />);
  });
}

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.phase = "connected";
  state.check.mockReset();
  resetProjectFolderChecksForTests();
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
});
const plain = (truncated: boolean) =>
  folderCheck({
    layout: {
      kind: "plain",
      rootIsRepository: false,
      repositories: [],
      repositoryCount: 0,
      truncated,
    },
  });

describe("projectFolderHealth", () => {
  it("reads a Git checkout as ok", () => {
    expect(projectFolderHealth(folderCheck())).toBe("ok");
  });
  it("reads a folder that is not there as missing", () => {
    expect(projectFolderHealth(folderCheck({ targetExists: false, layout: undefined }))).toBe(
      "missing",
    );
  });
  it("reads a file at the folder's path as a file", () => {
    expect(
      projectFolderHealth(
        folderCheck({
          targetExists: false,
          refusal: { reason: "folder_not_directory", detail: "a file" },
        }),
      ),
    ).toBe("file");
  });
  // A repository's subfolder, an unreadable folder, a cut-short walk and a plain
  // folder bound on purpose all read as plain; none of them is a broken project.
  it.each([false, true])("reads a folder without a repository as ok (truncated %s)", (cut) => {
    expect(projectFolderHealth(plain(cut))).toBe("ok");
  });
  it("reads an older server's answer without a layout as ok", () => {
    expect(projectFolderHealth(folderCheck({ layout: undefined }))).toBe("ok");
  });
});

describe("useProjectFolderHealth", () => {
  it("checks the project's own folder once and reports what it found", async () => {
    state.check.mockResolvedValue({
      _tag: "Success",
      value: folderCheck({ targetExists: false, layout: undefined }),
    });
    await render();
    await render();
    expect(state.check).toHaveBeenCalledTimes(1);
    expect(state.check).toHaveBeenCalledWith({
      environmentId: "host",
      input: { projectId: "project", workspaceRoot: "/w/atlas" },
    });
    expect(health()).toBe("missing");
  });
  it("never reports a failed or rejected check as missing", async () => {
    state.check.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("down") });
    await render();
    expect(health()).toBe("unknown");
    state.check.mockRejectedValueOnce(new Error("gone"));
    await render(project("/w/other"));
    expect(health()).toBe("unknown");
  });
  it("waits for the machine, then checks again after it reconnects", async () => {
    state.phase = "connecting";
    state.check.mockResolvedValue({ _tag: "Success", value: folderCheck() });
    await render();
    expect(state.check).not.toHaveBeenCalled();
    state.phase = "connected";
    await render();
    expect(state.check).toHaveBeenCalledTimes(1);
    expect(health()).toBe("ok");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + RECHECK_AFTER_MS);
    state.phase = "backoff";
    await render();
    state.phase = "connected";
    await render();
    expect(state.check).toHaveBeenCalledTimes(2);
  });
  it("checks a flapping machine's folder once per window, keeping its answer", async () => {
    state.check.mockResolvedValue({
      _tag: "Success",
      value: folderCheck({ targetExists: false, layout: undefined }),
    });
    await render();
    for (const phase of ["backoff", "connected", "backoff", "connected"]) {
      state.phase = phase;
      await render();
    }
    expect(state.check).toHaveBeenCalledTimes(1);
    expect(health()).toBe("missing");
  });
  it("shares one check between pages showing the same project", async () => {
    let settle: (value: unknown) => void = () => {};
    state.check.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    await render();
    let second: ReactTestRenderer | null = null;
    await act(async () => {
      second = create(<Probe project={project()} />);
    });
    await act(async () => settle({ _tag: "Success", value: folderCheck({ targetExists: false }) }));
    expect(state.check).toHaveBeenCalledTimes(1);
    expect(second!.toJSON()).toBe("missing");
    await act(async () => second!.unmount());
  });
  it("tries a failed check again on the next reconnect", async () => {
    state.check.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("warming up") });
    await render();
    expect(health()).toBe("unknown");
    state.check.mockResolvedValueOnce({ _tag: "Success", value: folderCheck() });
    state.phase = "backoff";
    await render();
    state.phase = "connected";
    await render();
    expect(state.check).toHaveBeenCalledTimes(2);
    expect(health()).toBe("ok");
  });
  it("forgets the last answer when the project's folder changes", async () => {
    state.check.mockResolvedValueOnce({
      _tag: "Success",
      value: folderCheck({ targetExists: false, layout: undefined }),
    });
    await render();
    expect(health()).toBe("missing");
    let settle: (value: unknown) => void = () => {};
    state.check.mockReturnValueOnce(new Promise((resolve) => (settle = resolve)));
    await render(project("/w/moved"));
    expect(health()).toBe("unknown");
    await act(async () => settle({ _tag: "Success", value: folderCheck() }));
    expect(health()).toBe("ok");
  });
});
