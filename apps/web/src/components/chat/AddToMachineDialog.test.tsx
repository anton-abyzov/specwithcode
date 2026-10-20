// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

import { readAddToMachineJob } from "../../studio/addToMachine";
import { AddToMachineDialog } from "./AddToMachineDialog";

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
  environments: {} as Record<string, unknown>,
  waitForProject: vi.fn(async () => ({})),
}));

vi.mock("../../state/sourceControl", () => ({
  sourceControlEnvironment: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../studio/projectLink", () => ({
  projectLink: new Proxy({}, { get: (_target, name) => `link:${String(name)}` }),
  linkCopyAsWorkers: (...args: unknown[]) => {
    state.calls.push(["linkCopyAsWorkers", args[1]]);
    return Promise.resolve({ status: "linked" });
  },
}));
vi.mock("../studio/ProjectLinkDialog", () => ({ ProjectLinkDialog: () => null }));
vi.mock("../studio/HandoffCopyPreview", () => ({
  CopyPlanPreview: () => null,
  CopyProgress: () => null,
  CopyUndoPreview: () => null,
}));
vi.mock("../../state/use-atom-command", () => ({
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
vi.mock("../../state/entities", () => ({ waitForProject: state.waitForProject }));
vi.mock("../../state/environments", () => ({
  useEnvironment: (id: string) => state.environments[id] ?? null,
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNicknames: () => (_id: string, label?: string | null) => label ?? "Machine",
}));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  newProjectId: () => "project-new",
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
}));

const capabilities = {
  cloneDestinationChecks: true,
  projectCloneTracking: true,
  projectLink: true,
};
const machine = (label: string, caps: Record<string, boolean> = capabilities) => ({
  label,
  serverConfig: { environment: { platform: { machine: "laptop" }, capabilities: caps } },
});
const source = {
  id: "app",
  environmentId: "m4",
  title: "App",
  workspaceRoot: "/Users/me/Projects/app",
  repositoryIdentity: {
    canonicalKey: "github.com/acme/app",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:acme/app.git",
    },
  },
  workspaceSettings: null,
} as unknown as EnvironmentProject;
const summary = {
  totals: {},
  repositories: [],
  secretFiles: [{ path: ".env", size: 10 }],
  linksOutside: 0,
  warnings: [],
};
const inspected = (state: string, sameRepository = false) => ({
  path: "/Users/me/Projects/app",
  state,
  originKey: null,
  sameRepository,
  checkedOut: state === "repository",
});

let root: Root | null = null;
let container: HTMLDivElement;
const onAdded = vi.fn();
const onOpenChange = vi.fn();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.calls = [];
  state.environments = { m4: machine("M4"), mini: machine("Mini") };
  state.handlers = {
    inspectDestination: () => inspected("missing"),
    checkRemoteAccess: () => ({ status: "ok", detail: null }),
    startProjectClone: () => ({}),
    copyOffer: () => ({
      operationId: "00000000-0000-4000-8000-000000000001",
      sourceEnvironmentId: "m4",
      sourceProjectId: "app",
      sourceUrl: "https://m4.example",
      sourceMachine: "M4",
      token: "t",
      title: "App",
      mode: "copy-only",
      status: { state: "scanned", summary, error: null },
    }),
  };
  state.waitForProject.mockClear();
  onAdded.mockClear();
  onOpenChange.mockClear();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  document.body.innerHTML = "";
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 350)));

async function render() {
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <AddToMachineDialog
        open
        onOpenChange={onOpenChange}
        source={source}
        destinationEnvironmentId={"mini" as EnvironmentId}
        onAdded={onAdded}
      />,
    ),
  );
  await settle();
}

const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find(
    (entry) => entry.textContent?.trim() === label,
  ) ?? null;
const calls = (name: string) => state.calls.filter(([entry]) => entry === name).map(([, v]) => v);

it("shows the source, the destination folder and the clone URL", async () => {
  await render();
  expect(text()).toContain("Add App to Mini");
  expect(text()).toContain("M4");
  expect(text()).toContain("/Users/me/Projects/app");
  expect(text()).toContain("Clone over SSH");
  expect(text()).toContain("HTTPS");
  expect(text()).toContain("git@github.com:acme/app.git");
  expect(text()).toContain("Folder on Mini");
  expect(text()).toContain("Copy ignored files");
  expect(text()).toContain("node_modules");
  expect(calls("inspectDestination")[0]).toEqual({
    environmentId: "mini",
    input: { path: "~/Projects/app", remoteUrl: "git@github.com:acme/app.git" },
  });
  expect(button("Cancel")).not.toBeNull();
  expect(button("Clone to Mini")?.disabled).toBe(false);
});

it("lists secret-like files unticked", async () => {
  await render();
  const box = document.body.querySelector<HTMLElement>('[aria-label="Send .env"]');
  expect(box?.getAttribute("aria-checked")).toBe("false");
});

it("blocks the clone when the destination can't read the repository", async () => {
  state.handlers.checkRemoteAccess = () => ({
    status: "no-access",
    detail: "Permission denied (publickey).",
  });
  await render();
  await act(async () => button("Clone to Mini")!.click());
  expect(text()).toContain(
    "Mini can't read this repository. Sign in to GitHub on Mini (gh auth login or an SSH key), then try again.",
  );
  expect(text()).toContain("Permission denied (publickey).");
  expect(calls("startProjectClone")).toEqual([]);
  expect(onAdded).not.toHaveBeenCalled();
});

it("asks an older destination to update", async () => {
  state.environments.mini = machine("Mini", { projectCloneTracking: true });
  await render();
  expect(text()).toContain("Mini needs a newer SpecWithCode to add projects.");
  expect(button("Clone to Mini")?.disabled).toBe(true);
  expect(calls("inspectDestination")).toEqual([]);
});

it("refuses a folder with other files and offers another one", async () => {
  state.handlers.inspectDestination = (request) =>
    (request as { input: { path: string } }).input.path === "~/Projects/app"
      ? inspected("not-repository")
      : { ...inspected("missing"), path: "/Users/me/Projects/app-2" };
  await render();
  expect(text()).toContain("That folder already has files that are not this repository.");
  expect(button("Clone to Mini")?.disabled).toBe(true);
  await act(async () => button("Use /Users/me/Projects/app-2")!.click());
  await settle();
  expect(document.body.querySelector<HTMLInputElement>('input[autocomplete="off"]')?.value).toBe(
    "/Users/me/Projects/app-2",
  );
  expect(button("Clone to Mini")?.disabled).toBe(false);
});

it("offers Link and consolidate for a checkout of the same repository", async () => {
  state.handlers.inspectDestination = () => inspected("repository", true);
  await render();
  expect(button("Clone to Mini")).toBeNull();
  expect(button("Link and consolidate")?.disabled).toBe(false);
});

it("clones, stores the follow-up job and hands the new project to the menu", async () => {
  await render();
  await act(async () => button("Clone to Mini")!.click());
  expect(calls("checkRemoteAccess")).toEqual([
    { environmentId: "mini", input: { remoteUrl: "git@github.com:acme/app.git" } },
  ]);
  expect(calls("startProjectClone")).toEqual([
    {
      environmentId: "mini",
      input: expect.objectContaining({
        projectId: "project-new",
        title: "App",
        remoteUrl: "git@github.com:acme/app.git",
        destinationPath: "/Users/me/Projects/app",
      }),
    },
  ]);
  expect(readAddToMachineJob("mini" as EnvironmentId, "project-new" as ProjectId)).toMatchObject({
    source: { environmentId: "m4", projectId: "app", workspaceRoot: "/Users/me/Projects/app" },
    destination: { environmentId: "mini", workspaceRoot: "/Users/me/Projects/app" },
    copyIgnored: false,
    secrets: [],
  });
  expect(state.waitForProject).toHaveBeenCalled();
  expect(onAdded).toHaveBeenCalledWith({ environmentId: "mini", projectId: "project-new" });
});

it("carries ticked secrets and ignored files into the follow-up job", async () => {
  await render();
  await act(async () =>
    document.body.querySelector<HTMLElement>('[aria-label="Send .env"]')!.click(),
  );
  expect(button("Clone to Mini")?.disabled).toBe(true);
  await act(async () =>
    document.body
      .querySelector<HTMLElement>('[data-slot="copy-secrets-confirm"] [data-slot="checkbox"]')!
      .click(),
  );
  const ignored = [...document.body.querySelectorAll("label")].find((entry) =>
    entry.textContent?.includes("Copy ignored files"),
  );
  await act(async () => ignored!.querySelector<HTMLElement>('[data-slot="checkbox"]')!.click());
  await act(async () => button("Clone to Mini")!.click());
  expect(readAddToMachineJob("mini" as EnvironmentId, "project-new" as ProjectId)).toMatchObject({
    copyIgnored: true,
    secrets: [".env"],
  });
});

it("links and consolidates an existing checkout after the copy is applied", async () => {
  const copyStatus = (copyState: string) => ({
    operationId: "00000000-0000-4000-8000-000000000001",
    state: copyState,
    rows: [],
    totals: { decisionsNeeded: 0 },
    disk: null,
    error: null,
    checks: [],
    projectId: copyState === "applied" ? "existing" : null,
    committed: copyState === "applied",
  });
  let applied = false;
  state.handlers.inspectDestination = () => inspected("repository", true);
  state.handlers.copyStatus = () => copyStatus(applied ? "applied" : "previewed");
  state.handlers.copyApprove = () => {
    applied = true;
    return copyStatus("applying");
  };
  await render();
  await act(async () => button("Link and consolidate")!.click());
  expect(calls("copyStart")).toEqual([
    {
      environmentId: "mini",
      input: expect.objectContaining({
        targetFolder: "/Users/me/Projects/app",
        selection: ["repository", "tracked", "untracked"],
      }),
    },
  ]);
  await act(async () => button("Apply and link")!.click());
  expect(calls("copySecrets")).toEqual([]);
  expect(calls("linkCopyAsWorkers")).toEqual([
    expect.objectContaining({
      kept: { environmentId: "m4", projectId: "app" },
      joining: { environmentId: "mini", projectId: "existing" },
    }),
  ]);
  expect(onAdded).not.toHaveBeenCalled();
  await act(async () => button("Done")!.click());
  expect(onAdded).toHaveBeenCalledWith({ environmentId: "mini", projectId: "existing" });
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
