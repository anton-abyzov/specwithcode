// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

import {
  listAddToMachineJobs,
  writeAddToMachineJob,
  type AddToMachineJob,
} from "../studio/addToMachine";
import { AddToMachineJobRunner } from "./AddToMachineJobRunner";

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
  clones: [] as Array<Record<string, unknown>>,
  projects: [] as Array<Record<string, unknown>>,
  link: { status: "linked" } as Record<string, unknown>,
  toasts: [] as Array<Record<string, unknown>>,
}));

vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/reactivity");
  return { useAtomValue: () => AsyncResult.success([]) };
});
vi.mock("../state/sourceControl", () => ({
  sourceControlEnvironment: new Proxy(
    {},
    { get: (_target, name) => (name === "projectClones" ? () => "clones" : name) },
  ),
}));
vi.mock("../state/projectClones", () => ({ useEnvironmentProjectClones: () => state.clones }));
vi.mock("../state/entities", () => ({
  useProjects: () => state.projects,
  useAllEnvironmentProjectSnapshotsReady: () => true,
  readProject: (ref: { environmentId: string; projectId: string }) =>
    state.projects.find(
      (entry) => entry.environmentId === ref.environmentId && entry.id === ref.projectId,
    ) ?? null,
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => ({
    serverConfig: { environment: { capabilities: { projectCloneTracking: true } } },
  }),
  useEnvironments: () => ({
    environments: [
      { environmentId: "m4", label: "M4" },
      { environmentId: "mini", label: "Mini" },
    ],
  }),
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (name: string) => async (request: unknown) => {
    state.calls.push([name, request]);
    try {
      return { _tag: "Success", value: await (state.handlers[name] ?? (() => null))(request) };
    } catch (error) {
      return { _tag: "Failure", error };
    }
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
  isAtomCommandInterrupted: () => false,
}));
vi.mock("../studio/machineHandoff", () => ({
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../studio/projectLink", () => ({
  projectLink: new Proxy({}, { get: (_target, name) => `link:${String(name)}` }),
  linkCopyAsWorkers: (...args: unknown[]) => {
    state.calls.push(["linkCopyAsWorkers", args[1]]);
    return Promise.resolve(state.link);
  },
}));
vi.mock("../studio/machineNickname", () => ({
  useMachineNicknames: () => (_id: string, label?: string | null) => label ?? "Machine",
}));
vi.mock("./studio/ProjectLinkDialog", () => ({ ProjectLinkDialog: () => null }));
vi.mock("./ui/toast", () => ({
  toastManager: { add: (toast: Record<string, unknown>) => state.toasts.push(toast) },
}));
vi.mock("./ui/toastHelpers", () => ({ stackedThreadToast: (toast: unknown) => toast }));

const env = (id: string) => id as EnvironmentId;
const source = {
  id: "app",
  environmentId: "m4",
  title: "App",
  workspaceRoot: "/Users/me/app",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/app.git",
    },
  },
  workspaceSettings: null,
};
const job = (projectId: string, extra: Partial<AddToMachineJob> = {}): AddToMachineJob => ({
  version: 1,
  source: {
    environmentId: env("m4"),
    projectId: "app" as ProjectId,
    workspaceRoot: "/Users/me/app",
  },
  destination: {
    environmentId: env("mini"),
    projectId: projectId as ProjectId,
    workspaceRoot: "/Users/me/app",
  },
  copyIgnored: false,
  secrets: [],
  createdAt: new Date().toISOString(),
  ...extra,
});
const destinationProject = (id: string) => ({ ...source, id, environmentId: "mini" });
const copyStatus = (copyState: string) => ({
  operationId: "op",
  state: copyState,
  rows: [],
  totals: { decisionsNeeded: 0 },
  error: null,
  projectId: copyState === "applied" ? "clone" : null,
  committed: copyState === "applied",
});

let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.calls = [];
  state.handlers = {};
  state.toasts = [];
  state.link = { status: "linked" };
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

async function run(projectId: string, phase: string, extra: Partial<AddToMachineJob> = {}) {
  writeAddToMachineJob(job(projectId, extra));
  state.projects = [source, destinationProject(projectId)];
  state.clones = [{ projectId, phase }];
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(<AddToMachineJobRunner />));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
}
const calls = (name: string) => state.calls.filter(([entry]) => entry === name).map(([, v]) => v);

it("links a finished clone to the source and clears the job", async () => {
  await run("clone-a", "done");
  expect(calls("linkCopyAsWorkers")).toEqual([
    expect.objectContaining({
      kept: { environmentId: "m4", projectId: "app" },
      joining: { environmentId: "mini", projectId: "clone-a" },
    }),
  ]);
  expect(calls("copyOffer")).toEqual([]);
  expect(listAddToMachineJobs()).toEqual([]);
});

it("waits while the clone runs and leaves a failed clone to the composer", async () => {
  await run("clone-b", "cloning");
  await act(async () => root?.unmount());
  await run("clone-c", "failed");
  expect(calls("linkCopyAsWorkers")).toEqual([]);
  expect(listAddToMachineJobs()).toHaveLength(2);
});

it("copies ignored files into the clone before linking", async () => {
  let applied = false;
  state.handlers.copyOffer = () => ({
    operationId: "op",
    sourceEnvironmentId: "m4",
    sourceProjectId: "app",
    sourceUrl: "https://m4.example",
    sourceMachine: "M4",
    token: "t",
    title: "App",
    mode: "copy-only",
    status: { state: "scanned", summary: { secretFiles: [] }, error: null },
  });
  state.handlers.copyStatus = () => copyStatus(applied ? "applied" : "previewed");
  state.handlers.copyApprove = () => {
    applied = true;
    return copyStatus("applying");
  };
  await run("clone-d", "done", { copyIgnored: true });
  expect(calls("copyStart")).toEqual([
    {
      environmentId: "mini",
      input: expect.objectContaining({
        targetFolder: "/Users/me/app",
        selection: ["repository", "ignoredData"],
      }),
    },
  ]);
  expect(calls("copyApprove")).toHaveLength(1);
  expect(calls("linkCopyAsWorkers")).toHaveLength(1);
  expect(listAddToMachineJobs()).toEqual([]);
});

it("asks for a review when linking needs one", async () => {
  state.link = { status: "review", reason: "The branches differ." };
  await run("clone-e", "done");
  expect(state.toasts).toEqual([
    expect.objectContaining({
      type: "warning",
      title: "App on Mini is not linked yet",
      description: "The branches differ.",
      actionProps: expect.objectContaining({ children: "Link…" }),
    }),
  ]);
  expect(listAddToMachineJobs()).toEqual([]);
});

describe("after a restart, with no clone snapshot left", () => {
  const stale = { createdAt: new Date(Date.now() - 60_000).toISOString() };
  const folder = (state: string, checkedOut: boolean) => ({
    path: "/Users/me/app",
    state,
    originKey: "github.com/acme/app",
    sameRepository: state === "repository",
    checkedOut,
  });
  async function restart(projectId: string, found: ReturnType<typeof folder>) {
    state.handlers.inspectDestination = () => found;
    writeAddToMachineJob(job(projectId, stale));
    state.projects = [source, destinationProject(projectId)];
    state.clones = [];
    root = createRoot(document.createElement("div"));
    await act(async () => root!.render(<AddToMachineJobRunner />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }

  it("leaves a clone git has not checked out", async () => {
    await restart("clone-r", folder("repository", false));
    expect(calls("inspectDestination")).toEqual([
      {
        environmentId: "mini",
        input: { path: "/Users/me/app", remoteUrl: "https://github.com/acme/app.git" },
      },
    ]);
    expect(calls("linkCopyAsWorkers")).toEqual([]);
    expect(listAddToMachineJobs()).toHaveLength(1);
    expect(state.toasts).toEqual([
      expect.objectContaining({ title: "App is not fully copied to Mini" }),
    ]);
  });

  it("links a clone git finished checking out", async () => {
    await restart("clone-s", folder("repository", true));
    expect(calls("linkCopyAsWorkers")).toHaveLength(1);
    expect(listAddToMachineJobs()).toEqual([]);
    expect(state.toasts).toEqual([]);
  });

  it("drops the job when the clone left nothing behind", async () => {
    await restart("clone-gone", folder("empty", false));
    expect(calls("linkCopyAsWorkers")).toEqual([]);
    expect(listAddToMachineJobs()).toEqual([]);
    expect(state.toasts).toEqual([
      expect.objectContaining({ title: "App did not finish copying to Mini" }),
    ]);
  });
});
