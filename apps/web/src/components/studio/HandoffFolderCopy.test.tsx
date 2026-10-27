// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DEFAULT_COPY_SELECTION } from "../../studio/folderCopy";
import {
  copyHandlers,
  CopyFixture,
  copyStatus,
  findButton,
  newRow,
  noSecrets,
  onBusyChange,
  onDialogClose,
  onOpenProject,
  project,
  stepState,
  summary,
  total,
  type FixtureOptions,
} from "./HandoffFolderCopy.testkit";

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
  uuid: 0,
  homes: {} as Record<string, string | null>,
  link: null as unknown as (...args: unknown[]) => Promise<unknown>,
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: true }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: { environmentId: string } | null) => ({
    data:
      input && state.homes[input.environmentId]
        ? { parentPath: state.homes[input.environmentId], entries: [] }
        : null,
    isPending: !!input && !state.homes[input.environmentId],
  }),
}));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../studio/projectLink", () => ({
  projectLink: new Proxy({}, { get: (_target, name) => `link:${String(name)}` }),
  linkCopyAsWorkers: (...args: unknown[]) => state.link(...args),
}));
vi.mock("./ProjectLinkDialog", () => ({
  ProjectLinkDialog: (props: { initialCandidate: unknown; initialKept: string }) => (
    <div data-slot="link-dialog">{JSON.stringify([props.initialCandidate, props.initialKept])}</div>
  ),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: string) => async (request: unknown) => {
    state.calls.push([name, request]);
    try {
      return { _tag: "Success", value: await state.handlers[name]!(request) };
    } catch (error) {
      return { _tag: "Failure", error };
    }
  },
}));
vi.mock("../settings/MachineReadinessChecklist", () => ({
  MachineReadinessChecklist: (props: { environmentId: string; projectId: string }) => (
    <p data-slot="readiness-stub">
      Readiness {props.environmentId} {props.projectId}
    </p>
  ),
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: unknown }) => failure.error,
}));
vi.mock("../../lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/utils")>()),
  randomUUID: () => `00000000-0000-4000-8000-00000000000${++state.uuid}`,
}));

let root: Root;
let container: HTMLDivElement;
let statuses: Array<Record<string, unknown>>;
const names = () => state.calls.map(([name]) => name);
const button = (label: string) => findButton(container, label);
const click = async (label: string) => {
  await act(async () => button(label).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const mount = (overrides: FixtureOptions = {}) =>
  act(async () => root.render(<CopyFixture {...overrides} />));
const dialogButton = (label: string) => {
  const matches = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (element) => element.textContent?.trim() === label,
  );
  expect(matches).toHaveLength(1);
  const result = matches[0]!;
  expect(result.closest('[data-slot="dialog-footer"]')).not.toBeNull();
  expect(result.closest('[data-slot="scroll-area-viewport"]')).toBeNull();
  return result;
};
const dialogClick = async (label: string) => {
  await act(async () => dialogButton(label).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  localStorage.clear();
  state.calls = [];
  state.uuid = 0;
  state.homes = { m3: "/home/anton", m1: "/Users/anton" };
  state.link = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ status: "linked" }));
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  state.handlers = copyHandlers({
    calls: () => state.calls,
    nextStatus: () => statuses.shift() ?? copyStatus("applied"),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("measures, previews and applies a copy that leaves the coordinator on the source", async () => {
  await mount();
  expect(container.textContent).toContain("Folder on M3");
  await click("Copy to M3");
  expect(state.calls.find(([name]) => name === "copyOffer")).toEqual([
    "copyOffer",
    {
      environmentId: "m4",
      input: {
        projectId: "source",
        operationId: "00000000-0000-4000-8000-000000000001",
        mode: "copy-only",
        destinationEnvironmentId: "m3",
      },
    },
  ]);
  const start = state.calls.find(([name]) => name === "copyStart")![1] as any;
  expect(start.environmentId).toBe("m3");
  expect(start.input).toMatchObject({
    token: "grant",
    targetFolder: "/home/anton/Projects/project",
  });
  expect(start.input.selection).not.toContain("secret");
  expect(start.input).not.toHaveProperty("projectId");
  await click("Copy to M3");
  expect(names()).not.toContain("prepare");
  expect(container.textContent).toContain("M3 has a copy in /Users/me/Projects/project");
  // Copy files only ends linked: the copy runs workers, the coordinator stays on M4.
  expect(state.link).toHaveBeenCalledOnce();
  expect(vi.mocked(state.link).mock.calls[0]![1]).toMatchObject({
    kept: { environmentId: "m4", projectId: "source" },
    joining: { environmentId: "m3", projectId: "copied" },
  });
  expect(container.textContent).toContain("Linked: the copy on M3 runs workers");
  await click("Open on M3");
  expect(onOpenProject).toHaveBeenCalledExactlyOnceWith({
    environmentId: "m3",
    projectId: "copied",
    folder: project.workspaceRoot,
  });
});

it("sends no secret file unless it is ticked and confirmed for that machine", async () => {
  state.handlers.copySecrets = ({ input }: any) => ({
    state: "scanned",
    summary,
    error: null,
    secrets: {
      files: [{ path: ".env", size: 10 }],
      approvedAt: 1,
      destinationLabel: input.destinationLabel,
    },
  });
  statuses = [
    copyStatus("previewed"),
    copyStatus("applied", {
      secrets: [{ path: ".env", writtenAs: ".env", size: 10, state: "written" }],
    }),
  ];
  await mount();
  await click("Copy to M3");
  const box = container.querySelector<HTMLElement>('[aria-label="Send .env"]')!;
  expect(box.getAttribute("aria-checked")).toBe("false");
  expect(container.textContent).not.toContain("API_TOKEN");
  await act(async () => box.click());
  expect(button("Copy to M3").disabled).toBe(true);
  expect(container.textContent).toContain("Send this secret file to M3");
  const confirm = container.querySelector<HTMLElement>(
    '[data-slot="copy-secrets-confirm"] [data-slot="checkbox"]',
  )!;
  await act(async () => confirm.click());
  await click("Copy to M3");
  const order = names();
  expect(order.indexOf("copySecrets")).toBeLessThan(order.indexOf("copyApprove"));
  expect(state.calls.find(([name]) => name === "copySecrets")![1]).toEqual({
    environmentId: "m4",
    input: {
      operationId: "00000000-0000-4000-8000-000000000001",
      paths: [".env"],
      destinationLabel: "M3",
    },
  });
  expect(container.textContent).toContain(".env is in place, readable only by you.");
  expect(container.textContent).toContain("Readiness m3 copied");
});

it("copies without asking the source for secrets when none are ticked", async () => {
  await mount();
  await click("Copy to M3");
  await click("Copy to M3");
  expect(names()).not.toContain("copySecrets");
});

it("keeps Apply disabled until every conflict has a decision", async () => {
  statuses = [
    copyStatus("previewed", {
      totals: { filesToMove: 1, bytesToMove: 1, bytesPresent: 0, decisionsNeeded: 1 },
    }),
  ];
  await mount();
  await click("Copy to M3");
  expect(button("Copy to M3").disabled).toBe(true);
});

it("checks the destination after Apply before fencing the source and starting context there", async () => {
  statuses = [
    copyStatus("previewed", { mode: "copy-and-move" }),
    copyStatus("applied", {
      mode: "copy-and-move",
      projectId: "00000000-0000-4000-8000-000000000002",
    }),
  ];
  await mount();
  const move = [...container.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) =>
    node.closest("label")?.textContent?.includes("Copy and transfer coordinator context"),
  )!;
  await act(async () => move.click());
  await click("Copy to M3");
  const start = state.calls.find(([name]) => name === "copyStart")![1] as any;
  expect(start.input.projectId).toBe("00000000-0000-4000-8000-000000000002");
  await click("Copy and transfer context to M3");
  const order = names().filter((name) => ["prepare", "copyApprove", "receive"].includes(name));
  expect(order).toEqual(["copyApprove", "prepare", "receive", "prepare", "receive"]);
  const published = state.calls.filter(([name]) => name === "prepare")[1]![1] as any;
  expect(published.input).toMatchObject({
    publish: true,
    destination: { transport: "folder-copy", environmentId: "m3" },
  });
  expect(container.textContent).toContain("The coordinator continues on M3");
  expect(localStorage.length).toBe(0);
});

it("drops an unfinished offer the destination never started and keeps one it cannot reach", async () => {
  const key = "specwithcode:folder-copy:m4:source";
  const pending = {
    operationId: "00000000-0000-4000-8000-000000000009",
    environmentId: "m3",
    mode: "copy-only",
    targetFolder: "/target",
    projectId: null,
  };
  localStorage.setItem(key, JSON.stringify(pending));
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("unreachable"), { _tag: "FolderCopyError", code: "unreachable" });
  };
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(names()).not.toContain("copySourceCancel");
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(container.textContent).toContain("A copy to /target on M3 is unfinished.");
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("gone"), { _tag: "FolderCopyError", code: "not_found" });
  };
  state.handlers.copySourceStatus = () => {
    throw Object.assign(new Error("gone"), { _tag: "FolderCopyError", code: "not_found" });
  };
  await click("Check the copy again");
  expect(names()).toContain("copySourceCancel");
  expect(localStorage.getItem(key)).toBeNull();
  expect(button("Copy to M3")).toBeTruthy();
});

it("offers the link review when a copy cannot be linked on its own", async () => {
  state.link = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    status: "review",
    reason: "Project notes differ on M3.",
  }));
  await mount();
  await click("Copy to M3");
  await click("Copy to M3");
  expect(container.textContent).toContain("Not linked yet. Project notes differ on M3.");
  await click("Link…");
  expect(container.querySelector('[data-slot="link-dialog"]')?.textContent).toBe(
    JSON.stringify([{ environmentId: "m3", projectId: "copied" }, "here"]),
  );
});

const inputFolder = () =>
  container.querySelector<HTMLInputElement>('input[aria-label="Folder on M3"]')!;
const editFolder = async (value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      inputFolder(),
      value,
    );
    inputFolder().dispatchEvent(new Event("input", { bubbles: true }));
  });
const selectMove = async () =>
  act(async () => {
    [...container.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((node) =>
        node.closest("label")?.textContent?.includes("Copy and transfer coordinator context"),
      )!
      .click();
  });
const deferredCopy = () => {
  statuses = [
    copyStatus("previewed", { mode: "copy-and-move" }),
    copyStatus("applied", {
      mode: "copy-and-move",
      projectId: "00000000-0000-4000-8000-000000000002",
    }),
  ];
};

it("uses the destination home and discloses the exact source root", async () => {
  await mount();
  expect(inputFolder().value).toBe("/home/anton/Projects/project");
  expect(container.querySelector('[data-slot="copy-source-folder"]')?.textContent).toContain(
    project.workspaceRoot,
  );
  expect(container.textContent).toContain(
    "Folders outside this root and linked folders are not followed",
  );
});

it("preserves a saved destination and typed path when remote home arrives late", async () => {
  state.homes.m3 = null;
  await mount({ savedFolder: "/srv/saved/project" });
  expect(inputFolder().value).toBe("/srv/saved/project");
  await editFolder("/srv/custom/project");
  state.homes.m3 = "/home/late";
  await mount({ savedFolder: "/srv/saved/project" });
  expect(inputFolder().value).toBe("/srv/custom/project");
});

it("does not use a previous machine's late home response", async () => {
  state.homes.m3 = null;
  await mount({ m1Available: true });
  expect(inputFolder().value).toBe("");
  await act(async () =>
    [...container.querySelectorAll<HTMLElement>('[role="radio"]')]
      .find((node) => node.closest("label")?.textContent?.trim() === "M1")!
      .click(),
  );
  state.homes.m3 = "/home/late-m3";
  await mount({ m1Available: true });
  expect(container.querySelector<HTMLInputElement>('input[aria-label="Folder on M1"]')!.value).toBe(
    "/Users/anton/Projects/project",
  );
});

it("finishes the copy while busy and transfers context only on an explicit retry", async () => {
  deferredCopy();
  state.handlers.prepare = () => {
    throw Object.assign(new Error("busy"), { code: "busy" });
  };
  await mount();
  await selectMove();
  await click("Copy to M3");
  await click("Copy and transfer context to M3");
  expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
  expect(container.textContent).toContain("The files are copied. Work is still running on M4");
  expect(names().indexOf("copyApprove")).toBeLessThan(names().indexOf("prepare"));
  expect(names()).not.toContain("receive");
  const prepares = names().filter((name) => name === "prepare").length;
  await mount();
  expect(names().filter((name) => name === "prepare")).toHaveLength(prepares);
  state.handlers.prepare = ({ input }: any) => ({
    publication: "published",
    bundle: {
      manifest: { operationId: input.operationId },
      destination: input.destination,
    },
  });
  await click("Transfer coordinator context");
  expect(names()).toContain("receive");
  expect(container.textContent).toContain("The coordinator continues on M3");
});

it("keeps a changed-source copy successful and asks for a fresh copy", async () => {
  deferredCopy();
  state.handlers.prepare = () => {
    throw Object.assign(new Error("changed"), { code: "source_changed" });
  };
  await mount();
  await selectMove();
  await click("Copy to M3");
  await click("Copy and transfer context to M3");
  expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
  expect(container.textContent).toContain("Copy again before transferring coordinator context");
  expect(button("Copy again")).toBeTruthy();
  expect(names()).not.toContain("receive");
});

it("reopening an applied copy never automatically transfers coordinator context", async () => {
  localStorage.setItem(
    "specwithcode:folder-copy:m4:source",
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-and-move",
      targetFolder: "/home/anton/project",
      projectId: "copied",
    }),
  );
  statuses = [copyStatus("applied", { mode: "copy-and-move" })];
  await mount();
  expect(container.textContent).toContain("Transfer coordinator context when you are ready");
  expect(names()).not.toContain("prepare");
  expect(names()).not.toContain("receive");
});

it("does not fence or transfer after copied files were unstable", async () => {
  deferredCopy();
  statuses[1] = { ...statuses[1], unstable: ["work-in-progress.ts"] };
  await mount();
  await selectMove();
  await click("Copy to M3");
  await click("Copy and transfer context to M3");
  expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
  expect(button("Copy again")).toBeTruthy();
  expect(names()).not.toContain("prepare");
});

it.each(["offline", "busy"])(
  "keeps the recovery pointer after publication and a %s receive",
  async (code) => {
    deferredCopy();
    state.handlers.receive = ({ input }: any) => {
      if (input.mode === "preview")
        return { phase: "ready", executionMode: "project-folder", projectId: input.projectId };
      throw Object.assign(new Error("Destination unavailable"), { code });
    };
    await mount();
    await selectMove();
    await click("Copy to M3");
    await click("Copy and transfer context to M3");
    expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
    expect(container.textContent).toContain("Coordinator context transfer is pending");
    expect(button("Start a new copy").disabled).toBe(true);
    expect(localStorage.getItem("specwithcode:folder-copy:m4:source")).not.toBeNull();
    expect(button("Transfer coordinator context").disabled).toBe(false);
  },
);

it.each([true, false])(
  "checks source recovery before restarting a reopened unstable copy (safe=%s)",
  async (safe) => {
    const key = "specwithcode:folder-copy:m4:source";
    localStorage.setItem(
      key,
      JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000009",
        environmentId: "m3",
        mode: "copy-and-move",
        targetFolder: "/home/anton/project",
        projectId: "copied",
      }),
    );
    statuses = [copyStatus("applied", { mode: "copy-and-move", unstable: ["changing.ts"] })];
    state.handlers.copyRelease = () => {
      if (!safe)
        throw new Error(
          "This context transfer is already published; recover it before starting another copy.",
        );
      return { released: false };
    };
    await mount();
    // Files changed while copying: Copy again leads, and context cannot transfer yet.
    expect(container.textContent).toContain(
      "The copy finished, but some files changed on M4 while copying.",
    );
    expect(container.querySelector('[aria-label="Changed while copying"]')?.textContent).toBe(
      "changing.ts",
    );
    expect(() => button("Transfer coordinator context")).toThrow();
    await click("Copy again");
    expect(names()).toContain("copyRelease");
    expect(names()).not.toContain("prepare");
    if (safe) {
      // A fresh copy of the same folder to the same machine starts measuring at once.
      expect(names().indexOf("copyRelease")).toBeLessThan(names().indexOf("copyOffer"));
      expect(state.calls.find(([name]) => name === "copyOffer")![1]).toMatchObject({
        environmentId: "m4",
        input: { mode: "copy-and-move", destinationEnvironmentId: "m3" },
      });
      const again = JSON.parse(localStorage.getItem(key)!);
      expect(again).toMatchObject({
        environmentId: "m3",
        mode: "copy-and-move",
        targetFolder: "/Users/me/Projects/project",
        projectId: "copied",
      });
      expect(again.operationId).not.toBe("00000000-0000-4000-8000-000000000009");
      // The reopened copy stopped to choose what to copy; so does the new one.
      expect(button("Preview on M3")).toBeTruthy();
    } else {
      expect(container.textContent).toContain("recover it before starting another copy");
      expect(localStorage.getItem(key)).not.toBeNull();
      expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
    }
  },
);

it.each(["same", "folder", "machine"])(
  "reuses a completed copy registration only for its exact destination (%s)",
  async (change) => {
    deferredCopy();
    const originalId = "00000000-0000-4000-8000-000000000002";
    statuses[1] = { ...statuses[1], targetFolder: "/home/anton/Projects/project" };
    state.handlers.prepare = () => {
      throw Object.assign(new Error("busy"), { code: "busy" });
    };
    await mount({ m1Available: true });
    await selectMove();
    await click("Copy to M3");
    await click("Copy and transfer context to M3");
    await click("Start a new copy");
    if (change === "folder") await editFolder("/home/anton/other-project");
    if (change === "machine") {
      // Same spelling on another machine must never reuse the registration.
      state.homes.m1 = "/home/anton";
      await mount({ m1Available: true });
      await act(async () =>
        [...container.querySelectorAll<HTMLElement>('[role="radio"]')]
          .find((node) => node.closest("label")?.textContent?.trim() === "M1")!
          .click(),
      );
    }
    statuses = [copyStatus("previewed", { mode: "copy-and-move" })];
    await click(`Copy to ${change === "machine" ? "M1" : "M3"}`);
    const starts = state.calls.filter(([name]) => name === "copyStart");
    const request = starts.at(-1)![1] as any;
    if (change === "same") expect(request.input.projectId).toBe(originalId);
    else expect(request.input.projectId).not.toBe(originalId);
    if (change === "same") expect(request.input.targetFolder).toBe("/home/anton/Projects/project");
  },
);

it("uses the existing project registration for a known destination folder", async () => {
  await mount({
    savedFolder: "/srv/project/",
    savedProject: (machine, folder) =>
      machine === "m3" && folder === "/srv/project/"
        ? { id: "existing-project", environmentId: "m3", workspaceRoot: "/srv/project" }
        : null,
  });
  await selectMove();
  await click("Copy to M3");
  const request = state.calls.find(([name]) => name === "copyStart")![1] as any;
  expect(request.input.projectId).toBe("existing-project");
});

it.each(["project-coordinator:existing-project", "custom-coordinator"])(
  "previews the full existing destination identity before publishing (%s)",
  async (coordinatorThreadId) => {
    const existing = {
      id: "existing-project",
      environmentId: "m3",
      workspaceRoot: "/srv/project",
      workspaceSettings: {
        coordinatorThreadId,
        logicalProject: { id: "existing-logical-project" },
      },
    };
    statuses = [
      copyStatus("previewed", { mode: "copy-and-move" }),
      copyStatus("applied", {
        mode: "copy-and-move",
        targetFolder: "/srv/project",
        projectId: "existing-project",
      }),
    ];
    const prepare = state.handlers.prepare!;
    state.handlers.prepare = async (request) => {
      const prepared = (await prepare(request)) as any;
      return {
        ...prepared,
        bundle: {
          ...prepared.bundle,
          context: { goal: "private goal", threads: [{ messages: ["private conversation"] }] },
          logicalProject: { id: "source-logical-project" },
          coordinatorBinding: { state: "active" },
        },
      };
    };
    await mount({ savedFolder: "/srv/project/", savedProject: () => existing });
    await selectMove();
    await click("Copy to M3");
    await click("Copy and transfer context to M3");
    const prepares = state.calls.filter(([name]) => name === "prepare");
    expect((prepares[0]![1] as any).input.destination).toMatchObject({
      projectId: "existing-project",
      coordinatorThreadId,
      logicalProjectId: "existing-logical-project",
      joinExistingProject: true,
    });
    const receive = state.calls.find(([name]) => name === "receive")![1] as any;
    expect(receive.input).toMatchObject({
      mode: "preview",
      projectId: "existing-project",
      destination: { coordinatorThreadId, logicalProjectId: "existing-logical-project" },
      logicalProject: { id: "source-logical-project" },
      coordinatorBinding: { state: "active" },
    });
    expect(receive.input).not.toHaveProperty("bundle");
    expect(receive.input).not.toHaveProperty("context");
    expect(JSON.stringify(receive)).not.toContain("private");
    expect(state.calls.indexOf(prepares[1]!)).toBeGreaterThan(names().indexOf("receive"));
    expect(container.textContent).toContain("The coordinator continues on M3");
  },
);

it.each(["busy", "conflict", "invalid"])(
  "keeps a destination preview refusal actionable without publishing (%s)",
  async (code) => {
    deferredCopy();
    state.handlers.receive = () => {
      throw Object.assign(new Error("Check the destination project"), { code });
    };
    await mount();
    await selectMove();
    await click("Copy to M3");
    await click("Copy and transfer context to M3");
    expect(container.querySelector('[data-slot="copy-done"]')).not.toBeNull();
    expect(container.textContent).toContain("M3 is not ready for coordinator context");
    expect(container.textContent).not.toContain("Work is still running on M4");
    expect(state.calls.filter(([name]) => name === "prepare")).toHaveLength(1);
    expect((state.calls.find(([name]) => name === "prepare")![1] as any).input.publish).toBe(false);
    expect(button("Start a new copy").disabled).toBe(false);
    expect(button("Transfer coordinator context").disabled).toBe(false);
    expect(localStorage.getItem("specwithcode:folder-copy:m4:source")).not.toBeNull();
    await click("Start a new copy");
    expect(names()).toContain("copyRelease");
    expect(button("Copy to M3")).toBeTruthy();
  },
);

it("retains a restored fence if source release refuses after a destination preview refusal", async () => {
  const key = "specwithcode:folder-copy:m4:source";
  localStorage.setItem(
    key,
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-and-move",
      targetFolder: "/home/anton/project",
      projectId: "copied",
    }),
  );
  statuses = [copyStatus("applied", { mode: "copy-and-move" })];
  state.handlers.receive = () => {
    throw new Error("Destination changed");
  };
  state.handlers.copyRelease = () => {
    throw new Error("Recover the published context transfer");
  };
  await mount();
  await click("Transfer coordinator context");
  await click("Start a new copy");
  expect(container.textContent).toContain("Recover the published context transfer");
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(button("Transfer coordinator context")).toBeTruthy();
});

it("reads a destination registration that arrived while Apply was running", async () => {
  deferredCopy();
  let registration: Record<string, unknown> | null = null;
  const options = { savedProject: () => registration };
  state.handlers.copyApprove = async () => {
    registration = {
      id: "00000000-0000-4000-8000-000000000002",
      environmentId: "m3",
      workspaceRoot: project.workspaceRoot,
      workspaceSettings: {
        coordinatorThreadId: "arrived-coordinator",
        logicalProject: { id: "arrived-logical-project" },
      },
    };
    await mount(options);
    return copyStatus("approved");
  };
  await mount(options);
  await selectMove();
  await click("Copy to M3");
  await click("Copy and transfer context to M3");
  const prepared = state.calls.find(([name]) => name === "prepare")![1] as any;
  expect(prepared.input.destination).toMatchObject({
    coordinatorThreadId: "arrived-coordinator",
    logicalProjectId: "arrived-logical-project",
  });
});

it("keeps live actions in the real dialog footer through measurement, preview, apply and completion", async () => {
  const originalOffer = state.handlers.copyOffer!;
  let finishOffer!: () => void;
  state.handlers.copyOffer = (input) =>
    new Promise((resolve) => {
      finishOffer = () => resolve(originalOffer(input));
    });
  await mount({ dialog: true });
  let finishPreview!: () => void;
  state.handlers.copyStart = () =>
    new Promise((resolve) => {
      finishPreview = () => resolve(copyStatus("scanning"));
    });
  await dialogClick("Copy to M3");
  // Measuring runs on the source: the dialog can close and the copy keeps going.
  dialogButton("Cancel copy");
  expect(document.querySelector('[data-slot="copy-measuring"]')?.textContent).toBe(
    "Measuring the folder…",
  );
  expect(document.body.textContent).toContain(
    "You can close this window; you'll get a notice when it's done.",
  );
  expect(document.body.textContent).toContain("Close keeps the copy going; Cancel copy stops it.");
  expect(
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"][aria-label="Close"]')
      ?.disabled,
  ).toBe(false);
  expect(document.querySelector('[data-slot="dialog-close"][aria-label="Close"]')).not.toBeNull();
  expect(names().filter((name) => name === "copyOffer")).toHaveLength(1);
  // One click: comparing starts as soon as measuring finishes.
  await act(async () => finishOffer());
  expect(dialogButton("Comparing folders…").disabled).toBe(true);
  expect(
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"][aria-label="Close"]')
      ?.disabled,
  ).toBe(false);
  expect(document.body.textContent).toContain("You can close this window.");
  await act(async () => finishPreview());
  // The secret-like .env keeps the secrets choice in front of the person.
  expect(document.querySelector('[data-slot="copy-secrets"]')).not.toBeNull();
  dialogButton("Copy to M3");
  let finishApply!: () => void;
  state.handlers.copyApprove = () =>
    new Promise((resolve) => {
      finishApply = () => resolve(copyStatus("approved"));
    });
  await dialogClick("Copy to M3");
  expect(dialogButton("Copying files…").disabled).toBe(true);
  expect(
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"][aria-label="Close"]')
      ?.disabled,
  ).toBe(false);
  await act(async () =>
    document
      .querySelector<HTMLButtonElement>('[data-slot="dialog-close"][aria-label="Close"]')!
      .click(),
  );
  expect(onDialogClose).toHaveBeenCalledExactlyOnceWith(false);
  // Closing never cancels the copy.
  expect(names()).not.toContain("copyCancel");
  expect(names()).not.toContain("copySourceCancel");
  await act(async () => finishApply());
  await dialogClick("Open on M3");
  expect(onOpenProject).toHaveBeenCalledOnce();
  dialogButton("Start a new copy");
  expect(
    document.querySelector('[data-slot="dialog-panel"] [data-slot="copy-actions"]'),
  ).toBeNull();
});

it("keeps a measurement error and its retry action together in the footer", async () => {
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = () => {
    throw new Error("The source folder cannot be read.");
  };
  await mount({ dialog: true });
  await dialogClick("Copy to M3");
  const alert = document.querySelector('[data-slot="dialog-footer"] [role="alert"]');
  expect(alert?.textContent).toContain("The source folder cannot be read.");
  expect(dialogButton("Copy to M3").disabled).toBe(false);
  state.handlers.copyOffer = offer;
  await dialogClick("Copy to M3");
  dialogButton("Copy to M3");
  expect(document.querySelector('[data-slot="dialog-footer"] [role="alert"]')).toBeNull();
});

it("keeps deferred context retry in the footer with current handlers", async () => {
  deferredCopy();
  const prepare = state.handlers.prepare!;
  state.handlers.prepare = () => {
    throw Object.assign(new Error("busy"), { code: "busy" });
  };
  await mount({ dialog: true });
  await act(async () => {
    const choice = [...document.querySelectorAll<HTMLElement>("label")].find((element) =>
      element.textContent?.includes("Copy and transfer coordinator context"),
    );
    choice!.click();
  });
  await dialogClick("Copy to M3");
  await dialogClick("Copy and transfer context to M3");
  expect(document.querySelector('[data-slot="copy-done"]')?.textContent).toContain(
    "Work is still running",
  );
  expect(dialogButton("Transfer coordinator context").disabled).toBe(false);
  state.handlers.prepare = prepare;
  await dialogClick("Transfer coordinator context");
  expect(document.querySelector('[data-slot="copy-done"]')?.textContent).toContain(
    "The coordinator continues",
  );
  dialogButton("Open on M3");
  expect(document.querySelector('[data-slot="dialog-footer"]')?.textContent).not.toContain(
    "Transfer coordinator context",
  );
});

it("keeps failed-copy Retry and cancellation in the footer; Retry before Apply copies again", async () => {
  statuses = [
    copyStatus("previewed"),
    copyStatus("failed", {
      failedStep: "transferring",
      // A stopped copy keeps its last counts; they must not read as still running.
      progress: {
        phase: "manifest",
        filesDone: 0,
        filesTotal: 0,
        bytesDone: 0,
        bytesTotal: 0,
        bytesLocal: 0,
      },
      error: { message: "Copy connection lost." },
    }),
  ];
  await mount({ dialog: true });
  await dialogClick("Copy to M3");
  await dialogClick("Copy to M3");
  expect(dialogButton("Retry").disabled).toBe(false);
  dialogButton("Cancel copy");
  expect(document.body.textContent).not.toContain("Reading the source list");
  const first = (state.calls.find(([name]) => name === "copyStart")![1] as any).input;
  statuses = [copyStatus("previewed")];
  await dialogClick("Retry");
  // The source let the copy go when it failed: Retry runs it again rather than asking
  // the destination to resume what it refuses to.
  expect(names().filter((name) => name === "copyRetry")).toHaveLength(0);
  // The old source operation is dropped so its snapshot is not orphaned.
  expect(state.calls.find(([name]) => name === "copySourceCancel")![1]).toMatchObject({
    input: { operationId: first.operationId },
  });
  const starts = state.calls.filter(([name]) => name === "copyStart");
  expect(starts).toHaveLength(2);
  expect((starts[1]![1] as any).input.operationId).not.toBe(first.operationId);
  // The same copy, into the folder the destination resolved for the first one.
  expect((starts[1]![1] as any).input).toMatchObject({
    targetFolder: "/Users/me/Projects/project",
    mode: first.mode,
    selection: first.selection,
  });
});

it("retries an interrupted Apply in place and keeps Retry when it is refused", async () => {
  statuses = [
    copyStatus("previewed"),
    copyStatus("failed", { failedStep: "applying", error: { message: "Apply stopped." } }),
  ];
  await mount({ dialog: true });
  await dialogClick("Copy to M3");
  await dialogClick("Copy to M3");
  state.handlers.copyRetry = () => {
    throw new Error("The copy is still finishing. Wait for it, then try again.");
  };
  await dialogClick("Retry");
  expect(names().filter((name) => name === "copyRetry")).toHaveLength(1);
  // The refusal is shown and Retry stays usable instead of a dead "Copying files…".
  expect(document.body.textContent).toContain("The copy is still finishing");
  expect(dialogButton("Retry").disabled).toBe(false);
  state.handlers.copyRetry = () => copyStatus("applying");
  statuses = [copyStatus("applied", { committed: true, projectId: "p3" })];
  await dialogClick("Retry");
  expect(names().filter((name) => name === "copyRetry")).toHaveLength(2);
  dialogButton("Open on M3");
});

const umbrellaRoot = "/Users/me/Projects/umbrella";
const childPath = "repos/org/app";
const childRoot = `${umbrellaRoot}/${childPath}`;
const umbrellaDestination = "/home/anton/Projects/umbrella";
const childDestination = `${umbrellaDestination}/${childPath}`;
const enableUmbrella = () => {
  state.handlers.copyScopes = () => ({
    projectRoot: childRoot,
    recommendedCopyRoot: umbrellaRoot,
    scopes: [
      {
        copyRoot: childRoot,
        projectRelativePath: ".",
        kind: "project",
        label: "This project folder",
        repositories: [],
        truncated: false,
      },
      {
        copyRoot: umbrellaRoot,
        projectRelativePath: childPath,
        kind: "workspace",
        label: "umbrella",
        repositories: [childPath, "custom/api"],
        truncated: true,
      },
    ],
  });
  const base = state.handlers.copyOffer!;
  state.handlers.copyOffer = (request: any) => ({
    ...(base(request) as object),
    copyRoot: request.input.copyRoot ?? childRoot,
    projectRelativePath: request.input.copyRoot === umbrellaRoot ? childPath : ".",
  });
};
const selectScope = async (root: string) =>
  act(async () =>
    [...container.querySelectorAll<HTMLElement>('[aria-label="Source folder"] [role="radio"]')]
      .find((node) => node.closest("label")?.querySelector(".font-mono")?.textContent === root)!
      .click(),
  );

it("defaults a nested project to its verified umbrella and maps the saved child registration once", async () => {
  enableUmbrella();
  await mount({ workspaceRoot: childRoot, savedFolder: "/srv/team/repos/org/app/" });
  const source = container.querySelector('[aria-label="Source folder"]')!;
  expect(source.querySelector('[aria-checked="true"]')?.closest("label")?.textContent).toContain(
    "Whole umbrella · umbrella (recommended)",
  );
  expect(source.textContent).toContain("This project folder only");
  expect(container.textContent).toContain("Included repositories (2+)");
  expect(container.textContent).not.toContain("open the umbrella project or choose its root");
  expect(inputFolder().value).toBe("/srv/team");
  expect(container.querySelector('[data-slot="copy-destination-project"]')?.textContent).toContain(
    "/srv/team/repos/org/app",
  );
  await click("Copy to M3");
  expect(names().indexOf("copyCapabilities")).toBeLessThan(names().indexOf("copyOffer"));
  expect(state.calls.find(([name]) => name === "copyOffer")?.[1]).toMatchObject({
    input: { copyRoot: umbrellaRoot },
  });
  expect(state.calls.find(([name]) => name === "copyStart")?.[1]).toMatchObject({
    input: {
      copyRoot: umbrellaRoot,
      projectRelativePath: childPath,
      targetFolder: "/srv/team",
    },
  });
});

it("refreshes automatic scope suggestions but preserves a manually entered destination", async () => {
  enableUmbrella();
  await mount({ workspaceRoot: childRoot, savedFolder: "/srv/unrelated/app" });
  expect(inputFolder().value).toBe(umbrellaDestination);
  await selectScope(childRoot);
  expect(inputFolder().value).toBe("/srv/unrelated/app");
  await editFolder("/srv/explicit-copy");
  await selectScope(umbrellaRoot);
  expect(inputFolder().value).toBe("/srv/explicit-copy");
  expect(container.querySelector('[data-slot="copy-destination-project"]')?.textContent).toContain(
    "/srv/explicit-copy/repos/org/app",
  );
});

it("blocks measurement until source discovery finishes, then visibly selects the recommendation", async () => {
  enableUmbrella();
  const scopes = state.handlers.copyScopes!(undefined);
  let resolve!: (value: unknown) => void;
  state.handlers.copyScopes = () =>
    new Promise((done) => {
      resolve = done;
    });
  await mount({ workspaceRoot: childRoot });
  expect(button("Copy to M3").disabled).toBe(true);
  await click("Copy to M3");
  expect(names()).not.toContain("copyOffer");
  await act(async () => resolve(scopes));
  expect(button("Copy to M3").disabled).toBe(false);
  expect(inputFolder().value).toBe(umbrellaDestination);
});

it("keeps a root-only copy available when an older source cannot discover umbrellas", async () => {
  state.handlers.copyScopes = () => {
    throw new Error("Unknown method");
  };
  await mount();
  expect(container.textContent).toContain("Only this project folder is available");
  await click("Copy to M3");
  expect(names()).not.toContain("copyCapabilities");
  expect(state.calls.find(([name]) => name === "copyOffer")?.[1]).not.toHaveProperty(
    "input.copyRoot",
  );
});

it.each(["unavailable", "old-version"])(
  "refuses an umbrella on an unsupported destination before creating any copy (%s)",
  async (reason) => {
    enableUmbrella();
    state.handlers.copyCapabilities = () => {
      if (reason === "unavailable") throw new Error("Unknown method");
      return { scopeVersion: 0 };
    };
    await mount({ workspaceRoot: childRoot });
    await click("Copy to M3");
    expect(container.textContent).toContain("Update or reconnect M3 before copying an umbrella");
    expect(names()).not.toContain("copyOffer");
    expect(localStorage.getItem("specwithcode:folder-copy:m4:source")).toBeNull();
    await selectScope(childRoot);
    await click("Copy to M3");
    expect(names()).toContain("copyOffer");
  },
);

it("registers, previews context and opens the child project while copying the whole umbrella", async () => {
  enableUmbrella();
  const existing = {
    id: "existing-child",
    environmentId: "m3",
    workspaceRoot: childDestination,
    workspaceSettings: { coordinatorThreadId: "child-coordinator" },
  };
  statuses = [
    copyStatus("previewed", {
      targetFolder: umbrellaDestination,
      copyRoot: umbrellaRoot,
      projectRelativePath: childPath,
      projectFolder: childDestination,
    }),
    copyStatus("applied", {
      targetFolder: umbrellaDestination,
      copyRoot: umbrellaRoot,
      projectRelativePath: childPath,
      projectFolder: childDestination,
      projectId: existing.id,
    }),
  ];
  await mount({
    workspaceRoot: childRoot,
    savedFolder: childDestination,
    savedProject: (machine, folder) =>
      machine === "m3" && folder === childDestination ? existing : null,
  });
  await selectMove();
  await click("Copy to M3");
  expect(state.calls.find(([name]) => name === "copyStart")?.[1]).toMatchObject({
    input: { projectId: existing.id, targetFolder: umbrellaDestination },
  });
  await click("Copy and transfer context to M3");
  expect(state.calls.find(([name]) => name === "prepare")?.[1]).toMatchObject({
    input: { destination: { projectId: existing.id, coordinatorThreadId: "child-coordinator" } },
  });
  expect(container.textContent).toContain(`The coordinator continues on M3 in ${childDestination}`);
  await click("Open on M3");
  expect(onOpenProject).toHaveBeenCalledExactlyOnceWith({
    environmentId: "m3",
    projectId: existing.id,
    folder: childDestination,
  });
});

it.each(["same", "child-only", "different-root"])(
  "reuses the canonical copied child only at the same registered folder (%s)",
  async (nextScope) => {
    enableUmbrella();
    const registration = "copied-child";
    const canonical = "/srv/canonical/umbrella";
    const canonicalChild = `${canonical}/${childPath}`;
    statuses = [
      copyStatus("previewed"),
      copyStatus("applied", {
        targetFolder: canonical,
        copyRoot: umbrellaRoot,
        projectRelativePath: childPath,
        projectFolder: canonicalChild,
        projectId: registration,
      }),
    ];
    state.handlers.prepare = () => {
      throw Object.assign(new Error("busy"), { code: "busy" });
    };
    await mount({ workspaceRoot: childRoot });
    await selectMove();
    await click("Copy to M3");
    await click("Copy and transfer context to M3");
    await click("Start a new copy");
    expect(inputFolder().value).toBe(canonical);
    if (nextScope === "different-root") await editFolder("/srv/other");
    if (nextScope === "child-only") {
      await selectScope(childRoot);
      expect(inputFolder().value).toBe(childDestination);
      await editFolder(canonicalChild);
    }
    statuses = [copyStatus("previewed")];
    await click("Copy to M3");
    const start = state.calls.findLast(([name]) => name === "copyStart")?.[1] as any;
    if (nextScope === "different-root") expect(start.input.projectId).not.toBe(registration);
    else expect(start.input.projectId).toBe(registration);
    expect(start.input.targetFolder).toBe(
      nextScope === "same" ? canonical : nextScope === "child-only" ? canonicalChild : "/srv/other",
    );
  },
);

const notFound = () => {
  throw Object.assign(new Error("gone"), { _tag: "FolderCopyError", code: "not_found" });
};
const scanning = (progress: { files: number; bytes: number } | null = null) => ({
  state: "scanning",
  summary: null,
  progress,
  error: null,
});
const waitPoll = () => act(async () => new Promise((resolve) => setTimeout(resolve, 1100)));
const moveMode = async () => {
  const move = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) =>
    node.closest("label")?.textContent?.includes("Copy and transfer coordinator context"),
  )!;
  await act(async () => move.click());
};
const skippedSummary = {
  ...summary,
  totals: { ...summary.totals, rebuildable: total(0, 0) },
  skipped: {
    rebuildableFolders: 412,
    worktrees: ["repositories/a/.worktrees/one", "repositories/a/.worktrees/two"],
  },
};

const chooseFirst = () =>
  act(async () =>
    container
      .querySelector<HTMLElement>('[data-slot="copy-choose-first"] [data-slot="checkbox"]')!
      .click(),
  );

it("shows live measuring progress, then stops to choose and groups what is not copied", async () => {
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = (input) => ({ ...(offer(input) as object), status: scanning() });
  state.handlers.copySourceStatus = () => scanning({ files: 41203, bytes: 1_200_000_000 });
  await mount();
  await chooseFirst();
  expect(container.textContent).toContain(
    "What happens next: Measures the folder, then you choose what to copy. Nothing is written to M3 until you approve.",
  );
  await click("Measure the folder");
  const measuring = () => container.querySelector('[data-slot="copy-measuring"]')?.textContent;
  expect(measuring()).toBe("Measuring the folder…");
  expect(container.textContent).toContain("You can close this window");
  await waitPoll();
  expect(measuring()).toBe("Measuring the folder… 41,203 files, 1.2 GB");
  state.handlers.copySourceStatus = () => ({
    state: "scanned",
    summary: skippedSummary,
    progress: null,
    error: null,
  });
  await waitPoll();
  // Choosing stops at the class picker: nothing is compared or approved yet.
  expect(button("Preview on M3")).toBeTruthy();
  expect(names()).not.toContain("copyStart");
  expect(names()).not.toContain("copyApprove");
  expect(stepState()).toEqual([
    "Where:done",
    "What:current",
    "Review:next",
    "Copy:next",
    "Done:next",
  ]);
  const block = container.querySelector('[data-slot="copy-not-copied"]')!;
  expect(block.querySelector('[data-slot="copy-not-copied-rebuildable"]')?.textContent).toBe(
    "412 dependency and build folders. Reinstall or rebuild them on M3.",
  );
  expect(block.querySelector('[data-slot="copy-not-copied-worktrees"]')?.textContent).toContain(
    "2 worktrees inside the folder.",
  );
  const rebuildable = container.querySelector('[data-class="rebuildable"]')!;
  expect(rebuildable.textContent).toContain("not measured");
  expect(rebuildable.textContent).not.toContain("0 files");
  expect(container.textContent).not.toContain("You can close this window.");
  expect(container.textContent).toContain(
    "What happens next: Preview compares with M3's folder. Nothing is written until you approve.",
  );
});

it("folds long worktree lists, names dirty worktrees and the root instead of a dot", async () => {
  const names49 = Array.from({ length: 49 }, (_, index) => `wt-${index + 1}`);
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = (input) => ({
    ...(offer(input) as object),
    status: {
      state: "scanned",
      summary: {
        ...summary,
        skipped: {
          rebuildableFolders: 0,
          worktrees: ["repos/a/.worktrees/clean", "repos/a/.worktrees/dirty"],
          dirtyWorktrees: ["repos/a/.worktrees/dirty"],
        },
        warnings: [
          `.: 49 worktree(s) outside this folder are not copied: ${names49.join(", ")}. Copy those working folders separately to preserve their uncommitted changes.`,
          ".: has a .git entry Git cannot read; it is copied as plain files.",
        ],
      },
      error: null,
    },
  });
  await mount();
  await chooseFirst();
  await click("Measure the folder");
  const text = container.textContent ?? "";
  expect(text).not.toContain(".:");
  expect(text).toContain("Project root: has a .git entry Git cannot read");
  const outside = container.querySelector('[data-slot="copy-not-copied-outside"]')!;
  expect(outside.textContent).toContain("49 worktrees outside the folder.");
  const fold = outside.querySelector<HTMLDetailsElement>("details")!;
  expect(fold.open).toBe(false);
  expect(fold.querySelector("summary")?.textContent).toBe("Show names (49)");
  expect(fold.querySelectorAll("li")).toHaveLength(49);
  const inside = container.querySelector('[data-slot="copy-not-copied-worktrees"]')!;
  expect(inside.querySelector('[data-slot="copy-dirty"]')?.textContent).toBe(
    "1 has uncommitted changes: repos/a/.worktrees/dirty. Uncommitted changes stay on this machine.",
  );
  expect(inside.querySelector("summary")?.textContent).toBe("Show names (1)");
  expect(container.querySelector('[data-slot="copy-not-copied-rebuildable"]')).toBeNull();
  expect(container.querySelector('[data-class="rebuildable"]')!.textContent).toContain("1 file");
});

it("cancels measuring on the source, releases a move and returns to setup without an error", async () => {
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = (input) => ({ ...(offer(input) as object), status: scanning() });
  state.handlers.copySourceStatus = () => scanning({ files: 10, bytes: 10 });
  await mount();
  await moveMode();
  await click("Copy to M3");
  const key = "specwithcode:folder-copy:m4:source";
  expect(localStorage.getItem(key)).not.toBeNull();
  const { operationId } = JSON.parse(localStorage.getItem(key)!);
  await click("Cancel copy");
  expect(state.calls.find(([name]) => name === "copySourceCancel")![1]).toMatchObject({
    environmentId: "m4",
    input: { operationId },
  });
  expect(state.calls.find(([name]) => name === "copyRelease")![1]).toMatchObject({
    environmentId: "m4",
    input: { projectId: "source", operationId },
  });
  expect(localStorage.getItem(key)).toBeNull();
  expect(
    container.querySelector('[data-slot="handoff-folder-copy"]')?.getAttribute("data-stage"),
  ).toBe("setup");
  expect(button("Copy to M3").disabled).toBe(false);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  await waitPoll();
  // The cancelled loop never polls again.
  const polls = names().filter((name) => name === "copySourceStatus").length;
  await waitPoll();
  expect(names().filter((name) => name === "copySourceStatus")).toHaveLength(polls);
});

it("keeps the dialog open only while coordinator context transfers", async () => {
  deferredCopy();
  let finishPrepare!: () => void;
  const prepare = state.handlers.prepare!;
  state.handlers.prepare = (input) =>
    new Promise((resolve) => {
      finishPrepare = () => resolve(prepare(input));
    });
  await mount({ dialog: true });
  await moveMode();
  await dialogClick("Copy to M3");
  await dialogClick("Copy and transfer context to M3");
  expect(dialogButton("Transferring context…").disabled).toBe(true);
  expect(document.querySelector('[data-slot="dialog-close"][aria-label="Close"]')).toBeNull();
  expect(document.body.textContent).not.toContain("You can close this window.");
  state.handlers.prepare = prepare;
  await act(async () => finishPrepare());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.querySelector('[data-slot="copy-done"]')?.textContent).toContain(
    "The coordinator continues",
  );
  expect(
    document.querySelector<HTMLButtonElement>('[data-slot="dialog-close"][aria-label="Close"]')
      ?.disabled,
  ).toBe(false);
});

it("keeps measuring when the dialog closes and resumes the same operation when reopened", async () => {
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = (input) => ({ ...(offer(input) as object), status: scanning() });
  state.handlers.copySourceStatus = () => scanning({ files: 5, bytes: 5000 });
  await mount();
  await click("Copy to M3");
  const key = "specwithcode:folder-copy:m4:source";
  const pointer = JSON.parse(localStorage.getItem(key)!);
  // Closing unmounts the flow; measuring continues on the source and the pointer stays.
  await act(async () => root.unmount());
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(names()).not.toContain("copySourceCancel");
  state.calls = [];
  state.handlers.copyStatus = notFound;
  state.handlers.copyOffer = (input) => ({
    ...(offer(input) as object),
    token: "fresh",
    status: scanning({ files: 7, bytes: 7000 }),
  });
  root = createRoot(container);
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(names()).not.toContain("copySourceCancel");
  expect(names()).not.toContain("copyRelease");
  expect(state.calls.find(([name]) => name === "copyOffer")![1]).toEqual({
    environmentId: "m4",
    input: {
      projectId: "source",
      operationId: pointer.operationId,
      mode: "copy-only",
      destinationEnvironmentId: "m3",
    },
  });
  expect(container.querySelector('[data-slot="copy-measuring"]')?.textContent).toBe(
    "Measuring the folder… 7 files, 7.0 KB",
  );
  state.handlers.copySourceStatus = () => ({
    state: "scanned",
    summary,
    progress: null,
    error: null,
  });
  await waitPoll();
  state.handlers.copyStatus = () => statuses.shift() ?? copyStatus("applied");
  await waitPoll();
  // A one-click copy closed while measuring goes on to compare by itself.
  expect(button("Copy to M3")).toBeTruthy();
  const start = state.calls.find(([name]) => name === "copyStart")![1] as any;
  expect(start.input).toMatchObject({ operationId: pointer.operationId, token: "fresh" });
});

it("restores a measured folder, its summary and selection when reopened", async () => {
  const key = "specwithcode:folder-copy:m4:source";
  localStorage.setItem(
    key,
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
      copyRoot: project.workspaceRoot,
      projectRelativePath: ".",
      selection: ["repository", "tracked", "rebuildable", "secret"],
    }),
  );
  state.handlers.copyStatus = notFound;
  state.handlers.copySourceStatus = () => ({
    state: "scanned",
    summary,
    progress: null,
    error: null,
  });
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(names()).not.toContain("copySourceCancel");
  expect(names()).toContain("copyOffer");
  expect(button("Preview on M3")).toBeTruthy();
  await click("Preview on M3");
  const start = state.calls.find(([name]) => name === "copyStart")![1] as any;
  expect(start.input).toMatchObject({
    operationId: "00000000-0000-4000-8000-000000000009",
    targetFolder: "/target",
    selection: ["repository", "tracked", "rebuildable"],
  });
});

it("drops a reopened copy whose source measuring failed and says why", async () => {
  const key = "specwithcode:folder-copy:m4:source";
  localStorage.setItem(
    key,
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
    }),
  );
  state.handlers.copyStatus = notFound;
  state.handlers.copySourceStatus = () => ({
    state: "failed",
    summary: null,
    progress: null,
    error: "The folder could not be read.",
  });
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(names()).not.toContain("copyOffer");
  expect(names()).toContain("copySourceCancel");
  expect(localStorage.getItem(key)).toBeNull();
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "The folder could not be read.",
  );
});

const measuredWithoutSecrets = () => {
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = (input) => ({
    ...(offer(input) as object),
    status: { state: "scanned", summary: noSecrets, error: null },
  });
  state.handlers.copySourceStatus = () => ({
    state: "scanned",
    summary: noSecrets,
    progress: null,
    error: null,
  });
};
/** Every stage the flow rendered, in order. */
const watchStages = () => {
  const seen: string[] = [];
  const record = () => {
    const stage = container
      .querySelector('[data-slot="handoff-folder-copy"]')
      ?.getAttribute("data-stage");
    if (stage && seen.at(-1) !== stage) seen.push(stage);
  };
  const observer = new MutationObserver(record);
  observer.observe(container, { subtree: true, childList: true, attributes: true });
  record();
  return { seen, stop: () => observer.disconnect() };
};

it("copies into an empty destination in one click without a preview", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", { rows: [newRow("."), newRow("repos/api")] }),
    copyStatus("applied"),
  ];
  let finishApprove!: () => void;
  state.handlers.copyApprove = () =>
    new Promise((resolve) => {
      finishApprove = () => resolve(copyStatus("approved"));
    });
  await mount();
  expect(stepState()).toEqual([
    "Where:current",
    "What:next",
    "Review:next",
    "Copy:next",
    "Done:next",
  ]);
  expect(container.textContent).toContain(
    "What happens next: Measures the folder, then copies it to M3. Nothing on M3 is replaced without asking.",
  );
  const stages = watchStages();
  await click("Copy to M3");
  expect(container.textContent).toContain(
    "What happens next: Copying 50 B. You can close this window; you'll get a notice when it's done.",
  );
  expect(stepState()).toEqual([
    "Where:done",
    "What:done",
    "Review:done",
    "Copy:current",
    "Done:next",
  ]);
  await act(async () => finishApprove());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  stages.stop();
  expect(names().filter((name) => name === "copyApprove")).toHaveLength(1);
  expect(names()).not.toContain("copyDecide");
  expect(stages.seen).not.toContain("preview");
  expect(stages.seen).not.toContain("select");
  expect(container.querySelector('[data-slot="copy-preview"]')).toBeNull();
  expect(container.textContent).toContain("M3 has a copy in /Users/me/Projects/project");
  expect(stepState()).toEqual([
    "Where:done",
    "What:done",
    "Review:done",
    "Copy:done",
    "Done:current",
  ]);
  // The pointer written by measuring kept the one-click choice and the selection.
  expect(JSON.parse(localStorage.getItem("specwithcode:folder-copy:m4:source")!)).toMatchObject({
    auto: true,
    method: "copy",
    selection: DEFAULT_COPY_SELECTION,
  });
});

it("shows only what would be replaced and copies with Replace all", async () => {
  measuredWithoutSecrets();
  const conflictRow = {
    ...newRow(".", { status: "conflict", needsDecision: true }),
    id: "files",
    kind: "files",
    conflicts: [
      {
        id: "file:a.txt",
        path: "a.txt",
        reason: "differs",
        choices: ["keep-mine", "take-theirs", "keep-both"],
        decision: null,
      },
    ],
    moreConflicts: 1,
  };
  const diverged = newRow("repos/app", {
    status: "diverged",
    choices: ["keep-mine", "take-theirs", "leave-both"],
    needsDecision: true,
  });
  statuses = [
    copyStatus("previewed", {
      rows: [newRow("repos/new"), diverged, conflictRow],
      totals: { filesToMove: 3, bytesToMove: 30, bytesPresent: 0, decisionsNeeded: 3 },
    }),
    copyStatus("previewed", { rows: [newRow("repos/new")] }),
    copyStatus("applied"),
  ];
  await mount();
  await click("Copy to M3");
  expect(names()).not.toContain("copyApprove");
  expect(container.querySelector('[data-slot="copy-preview-headline"]')?.textContent).toBe(
    "2 files and 1 repository on M3 would be replaced. Old versions are kept so you can undo.",
  );
  const rows = [...container.querySelectorAll('[data-slot="copy-row"]')];
  expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["diverged", "conflict"]);
  expect(container.querySelector('[data-slot="copy-preview-untouched"]')?.textContent).toBe(
    "1 other folder is new or unchanged and is copied as it is.",
  );
  expect(stepState()).toEqual([
    "Where:done",
    "What:done",
    "Review:current",
    "Copy:next",
    "Done:next",
  ]);
  expect(button("Copy with these choices").disabled).toBe(true);
  await click("Replace all");
  expect(state.calls.find(([name]) => name === "copyDecide")![1]).toEqual({
    environmentId: "m3",
    input: {
      operationId: "00000000-0000-4000-8000-000000000001",
      decisions: { "repo:repos/app": "take-theirs", "all:files": "take-theirs" },
    },
  });
  expect(names().filter((name) => name === "copyApprove")).toHaveLength(1);
  expect(names().indexOf("copyDecide")).toBeLessThan(names().indexOf("copyApprove"));
  expect(container.textContent).toContain("M3 has a copy in");
});

const filesConflict = (
  conflicts: ReadonlyArray<{ id: string; decision: string | null }>,
  moreConflicts: number,
) => ({
  ...newRow(".", { status: "conflict", needsDecision: true }),
  id: "files",
  kind: "files",
  conflicts: conflicts.map(({ id, decision }) => ({
    id,
    path: id,
    reason: "differs",
    choices: ["keep-mine", "take-theirs", "keep-both"],
    decision,
  })),
  moreConflicts,
});

it("says a re-compare after a choice shows the plan again instead of promising a copy", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", {
      rows: [filesConflict([{ id: "a.txt", decision: null }], 1)],
      totals: counted(2, 2),
    }),
  ];
  // The re-compare keeps running, so the planning text stays on screen.
  state.handlers.copyStatus = () => statuses.shift() ?? copyStatus("scanning");
  await mount();
  await click("Copy to M3");
  await act(async () =>
    container.querySelector<HTMLButtonElement>('[data-slot="copy-conflicts-all"] button')!.click(),
  );
  await settle();
  expect(
    container.querySelector('[data-slot="handoff-folder-copy"]')?.getAttribute("data-stage"),
  ).toBe("planning");
  expect(container.textContent).toContain("What happens next: Comparing again with your choices…");
  expect(container.textContent).not.toContain("Copying starts on its own");
});

it("says Replace all compares again and then copies with every conflict replaced", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", {
      rows: [filesConflict([{ id: "a.txt", decision: null }], 1)],
      totals: counted(2, 2),
    }),
  ];
  state.handlers.copyStatus = () => statuses.shift() ?? copyStatus("scanning");
  await mount();
  await click("Copy to M3");
  await click("Replace all");
  expect(container.textContent).toContain(
    "What happens next: Comparing again, then copying with every conflict replaced.",
  );
});

it("counts only what Replace all sends and names unlisted conflicts it leaves open", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", {
      rows: [
        filesConflict(
          [
            { id: "kept.txt", decision: "keep-mine" },
            { id: "open.txt", decision: null },
          ],
          3,
        ),
      ],
      totals: { filesToMove: 5, bytesToMove: 50, bytesPresent: 0, decisionsNeeded: 4 },
    }),
  ];
  state.handlers.copyStatus = () => statuses.shift() ?? copyStatus("scanning");
  await mount();
  await click("Copy to M3");
  expect(container.querySelector('[data-slot="copy-preview-headline"]')?.textContent).toBe(
    "1 file on M3 would be replaced. Old versions are kept so you can undo.3 more conflicts in Other files still need a choice.",
  );
  expect(container.textContent).not.toContain("Replace all starts copying now");
  await click("Replace all");
  // Only the open listed conflict is answered: the unlisted ones stay open.
  expect(state.calls.find(([name]) => name === "copyDecide")![1]).toMatchObject({
    input: { decisions: { "open.txt": "take-theirs" } },
  });
  expect(container.textContent).toContain("What happens next: Comparing again with your choices…");
});

it("makes failed checks and files changed while copying obvious and copies again", async () => {
  const changed = Array.from({ length: 23 }, (_, index) => `src/changed-${index}.ts`);
  statuses[1] = {
    ...statuses[1],
    unstable: changed,
    checks: [
      { repo: ".", ok: true, problems: [] },
      { repo: "app", ok: false, problems: ["git status differs from the source.", "src/a.ts"] },
    ],
  };
  await mount();
  await click("Copy to M3");
  await click("Copy to M3");
  const problems = container.querySelector('[data-slot="copy-problems"]')!;
  expect(problems.querySelector('[role="alert"]')?.textContent).toBe(
    "The copy finished, but some files changed on M4 while copying. Copy again: it compares first and moves only what changed.",
  );
  const listed = problems.querySelectorAll('[aria-label="Changed while copying"] li');
  expect(listed).toHaveLength(20);
  expect(problems.textContent).toContain("and 3 more.");
  expect(
    [...problems.querySelectorAll('[aria-label="Problems in app"] li')].map((li) => li.textContent),
  ).toEqual(["git status differs from the source.", "src/a.ts"]);
  expect(problems.textContent).not.toContain("Root");
  expect(container.textContent).toContain(
    "What happens next: Copy again to bring over what changed since; it compares first and moves only changed files.",
  );
  const labels = [...container.querySelectorAll("button")].map((node) => node.textContent?.trim());
  expect(labels.indexOf("Copy again")).toBeLessThan(labels.indexOf("Open on M3"));
  const first = (state.calls.find(([name]) => name === "copyStart")![1] as any).input;
  statuses = [copyStatus("previewed")];
  await click("Copy again");
  // A fresh one-click copy of the same folder to the same machine with the same choices.
  expect(names().filter((name) => name === "copyOffer")).toHaveLength(2);
  const starts = state.calls.filter(([name]) => name === "copyStart");
  expect(starts).toHaveLength(2);
  const second = (starts[1]![1] as any).input;
  expect(second.operationId).not.toBe(first.operationId);
  expect(second).toMatchObject({
    targetFolder: "/Users/me/Projects/project",
    mode: "copy-only",
    selection: first.selection,
  });
  expect(pointerNow()).toMatchObject({ auto: true, environmentId: "m3", method: "copy" });
  expect(container.querySelector('[data-slot="copy-problems"]')).toBeNull();
});

it("continues the clone method's choice and one-click approval for a copy closed while comparing", async () => {
  measuredWithoutSecrets();
  localStorage.setItem(
    "specwithcode:folder-copy:m4:source",
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
      auto: true,
      method: "clone",
    }),
  );
  statuses = [
    copyStatus("previewed", { rows: [newRow("repos/app", { cloneAvailable: true })] }),
    copyStatus("previewed", {
      rows: [newRow("repos/app", { cloneAvailable: true, clone: true })],
    }),
    copyStatus("applied"),
  ];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(state.calls.find(([name]) => name === "copyDecide")![1]).toEqual({
    environmentId: "m3",
    input: { operationId: "00000000-0000-4000-8000-000000000009", clone: ["repo:repos/app"] },
  });
  expect(names().indexOf("copyDecide")).toBeLessThan(names().indexOf("copyApprove"));
  expect(names().filter((name) => name === "copyApprove")).toHaveLength(1);
  expect(container.textContent).toContain("M3 has a copy in");
});

it("keeps the person's clone choices when a decided clone copy is reopened", async () => {
  localStorage.setItem(
    "specwithcode:folder-copy:m4:source",
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
      method: "clone",
      cloneDecided: true,
    }),
  );
  state.handlers.copySourceStatus = () => ({
    state: "ready",
    summary,
    progress: null,
    error: null,
  });
  statuses = [copyStatus("previewed", { rows: [newRow("repos/app", { cloneAvailable: true })] })];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(names()).not.toContain("copyDecide");
  expect(names()).not.toContain("copyApprove");
  // A reopened preview shows the secrets step from the source's summary.
  expect(container.querySelector('[data-slot="copy-secrets"]')).not.toBeNull();
});

it("keeps the preview while repository clicks re-compare once", async () => {
  localStorage.setItem(
    "specwithcode:folder-copy:m4:source",
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
      method: "copy",
    }),
  );
  state.handlers.copySourceStatus = () => ({
    state: "ready",
    summary,
    progress: null,
    error: null,
  });
  const rows = [
    newRow("."),
    newRow("repos/app", { cloneAvailable: true }),
    newRow("repos/ec", { cloneAvailable: true }),
  ];
  statuses = [
    copyStatus("previewed", { rows }),
    copyStatus("previewed", {
      rows: [
        rows[0],
        { ...rows[1], clone: true },
        { ...rows[2], status: "skipped", filesToMove: 0 },
      ],
    }),
  ];
  await mount();
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const checkbox = (label: string) =>
    container.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
  const cloneApp = container.querySelector<HTMLElement>(
    '[data-slot="copy-clone"] [data-slot="checkbox"]',
  )!;
  await act(async () => cloneApp.click());
  await act(async () => checkbox("Copy repos/ec").click());
  // Shown at once, before the destination answers; the preview is not replaced.
  expect(container.querySelector('[data-slot="copy-row"][data-copied="false"]')).not.toBeNull();
  expect(container.textContent).toContain("Updating sizes…");
  expect(names()).not.toContain("copyDecide");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
  expect(state.calls.filter(([name]) => name === "copyDecide")).toEqual([
    [
      "copyDecide",
      {
        environmentId: "m3",
        input: {
          operationId: "00000000-0000-4000-8000-000000000009",
          clone: ["repo:repos/app"],
          skip: ["repo:repos/ec"],
        },
      },
    ],
  ]);
  expect(container.querySelector('[data-slot="copy-preview"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Updating sizes…");
  expect(container.textContent).not.toContain("Comparing with");
});

it("reports not busy when the copy flow unmounts mid-measure", async () => {
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = (input) => ({ ...(offer(input) as object), status: scanning() });
  state.handlers.copySourceStatus = () => scanning({ files: 1, bytes: 1 });
  await mount();
  await click("Copy to M3");
  expect(onBusyChange).toHaveBeenLastCalledWith(true);
  await act(async () => root.unmount());
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
  root = createRoot(container);
});

it("says Close keeps the copy and Cancel copy stops it while copying", async () => {
  measuredWithoutSecrets();
  statuses = [copyStatus("previewed", { rows: [newRow(".")] })];
  state.handlers.copyStatus = () => statuses.shift() ?? copyStatus("transferring");
  await mount();
  await click("Copy to M3");
  expect(container.querySelector('[data-slot="copy-close-hint"]')?.textContent).toBe(
    "Close keeps the copy going; Cancel copy stops it.",
  );
  expect(button("Cancel copy")).toBeTruthy();
});

const headline = () =>
  container.querySelector('[data-slot="copy-preview-headline"]')?.textContent ?? null;
const pointerNow = () =>
  JSON.parse(localStorage.getItem("specwithcode:folder-copy:m4:source") ?? "null");
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const counted = (replacing: number, decisionsNeeded = 0) => ({
  filesToMove: 1,
  bytesToMove: 10,
  bytesPresent: 0,
  decisionsNeeded,
  replacing,
});

it("asks before a one-click copy whose unchanged folder would overwrite files", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", {
      rows: [newRow(".", { replacing: 0 }), newRow("repos/api", { status: "same", replacing: 2 })],
      totals: counted(2),
    }),
  ];
  await mount();
  await click("Copy to M3");
  expect(names()).not.toContain("copyApprove");
  expect(headline()).toBe(
    "2 files on M3 would be replaced. Old versions are kept so you can undo.",
  );
  const rows = [...container.querySelectorAll('[data-slot="copy-row"]')];
  expect(rows.map((row) => row.getAttribute("data-status"))).toEqual(["same"]);
  expect(button("Copy to M3")).toBeTruthy();
});

it("asks before copying over a folder an older destination cannot count", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", { rows: [newRow("."), newRow("repos/api", { status: "same" })] }),
  ];
  await mount();
  await click("Copy to M3");
  expect(names()).not.toContain("copyApprove");
  expect(headline()).toBe(
    "M3 already has some of these folders. Check the changes below before copying.",
  );
});

it("copies in one click with secret-like files left on the source, and says so when done", async () => {
  // The default summary has a secret-like .env.
  statuses = [copyStatus("previewed", { rows: [newRow(".")] }), copyStatus("applied")];
  await mount();
  await click("Copy to M3");
  expect(names().filter((name) => name === "copyApprove")).toHaveLength(1);
  expect(names()).not.toContain("copySecrets");
  expect(container.querySelector('[data-slot="copy-secrets"]')).toBeNull();
  expect(container.querySelector('[data-slot="copy-secrets-left"]')?.textContent).toBe(
    "1 secret-like file (.env and similar) stayed on M4. Copy them yourself, or run the copy again with Choose what to copy to send them.",
  );
});

it("keeps Replace all when the dialog closes during the re-compare and approves on reopen", async () => {
  measuredWithoutSecrets();
  const diverged = newRow("repos/app", {
    status: "diverged",
    choices: ["keep-mine", "take-theirs", "leave-both"],
    needsDecision: true,
  });
  statuses = [
    copyStatus("previewed", {
      rows: [diverged],
      totals: { filesToMove: 1, bytesToMove: 10, bytesPresent: 0, decisionsNeeded: 1 },
    }),
  ];
  // The re-compare is still running when the dialog closes.
  state.handlers.copyStatus = () => statuses.shift() ?? copyStatus("scanning");
  await mount();
  await click("Copy to M3");
  await click("Replace all");
  expect(pointerNow()).toMatchObject({ replaceAll: true });
  await act(async () => root.unmount());
  expect(pointerNow()).toMatchObject({ replaceAll: true });
  expect(names()).not.toContain("copyApprove");
  state.calls = [];
  statuses = [
    copyStatus("previewed", { rows: [{ ...diverged, decision: "take-theirs" }] }),
    copyStatus("applied"),
  ];
  state.handlers.copyStatus = () => statuses.shift() ?? copyStatus("applied");
  root = createRoot(container);
  await mount();
  await settle();
  expect(names()).not.toContain("copyDecide");
  expect(names().filter((name) => name === "copyApprove")).toHaveLength(1);
  expect(container.textContent).toContain("M3 has a copy in");
});

it("drops a pending Replace all when the re-compared plan still needs a choice", async () => {
  localStorage.setItem(
    "specwithcode:folder-copy:m4:source",
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
      auto: true,
      replaceAll: true,
    }),
  );
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", {
      rows: [
        newRow("repos/app", { status: "diverged", choices: ["keep-mine"], needsDecision: true }),
      ],
      totals: { filesToMove: 1, bytesToMove: 10, bytesPresent: 0, decisionsNeeded: 1 },
    }),
  ];
  await mount();
  await settle();
  expect(names()).not.toContain("copyApprove");
  expect(pointerNow()).not.toHaveProperty("replaceAll");
  expect(container.querySelector('[data-slot="copy-preview"]')).not.toBeNull();
});

it("carries on when an approval landed although its answer was lost", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", { rows: [newRow(".")] }),
    copyStatus("transferring"),
    copyStatus("applied"),
  ];
  state.handlers.copyApprove = () => {
    throw new Error("The connection dropped.");
  };
  await mount();
  await click("Copy to M3");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("M3 has a copy in");
});

it("shows the approval error only when the plan is still waiting", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", { rows: [newRow(".")] }),
    copyStatus("previewed", { rows: [newRow(".")] }),
  ];
  state.handlers.copyApprove = () => {
    throw new Error("The connection dropped.");
  };
  await mount();
  await click("Copy to M3");
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("The connection dropped.");
  expect(container.querySelector('[data-slot="copy-preview"]')).not.toBeNull();
});

it("keeps skipped worktrees and secret counts when an applied copy is reopened", async () => {
  localStorage.setItem(
    "specwithcode:folder-copy:m4:source",
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
    }),
  );
  state.handlers.copySourceStatus = () => ({
    state: "committed",
    summary: {
      ...summary,
      skipped: {
        rebuildableFolders: 0,
        worktrees: ["wt/a", "wt/b", "wt/c", "wt/d"],
        dirtyWorktrees: ["wt/a"],
        uncheckedWorktrees: ["wt/b"],
        strandedWorktrees: ["wt/c"],
        worktreeCount: 40,
        dirtyCount: 3,
      },
    },
    progress: null,
    error: null,
  });
  statuses = [copyStatus("applied")];
  await mount();
  await settle();
  const block = container.querySelector('[data-slot="copy-not-copied-worktrees"]')!;
  expect(block.textContent).toContain("40 worktrees inside the folder.");
  expect(block.querySelector('[data-slot="copy-dirty"]')?.textContent).toBe(
    "3 have uncommitted changes: wt/a and 2 more. Uncommitted changes stay on this machine.",
  );
  expect(block.querySelector('[data-slot="copy-unchecked"]')?.textContent).toBe(
    "1 worktree could not be checked; it may hold uncommitted changes: wt/b.",
  );
  expect(block.querySelector('[data-slot="copy-stranded"]')?.textContent).toBe(
    "1 has commits on no branch that would not travel: wt/c. Commit that work to a branch to copy it.",
  );
  // Only the worktree with nothing at risk is folded away.
  expect(block.querySelector("summary")?.textContent).toBe("Show names (1)");
  expect(block.querySelector('[aria-label="Worktrees not copied"]')?.textContent).toBe("wt/d");
  expect(container.querySelector('[data-slot="copy-secrets-left"]')?.textContent).toContain(
    "1 secret-like file (.env and similar) stayed on M4.",
  );
});

it("offers the plain copy button once every choice keeps the destination's version", async () => {
  measuredWithoutSecrets();
  const kept = newRow("repos/app", {
    status: "diverged",
    choices: ["keep-mine", "take-theirs", "leave-both"],
    needsDecision: true,
    decision: "keep-mine",
  });
  statuses = [copyStatus("previewed", { rows: [kept] }), copyStatus("applied")];
  await mount();
  await click("Copy to M3");
  expect(container.textContent).not.toContain("Replace all");
  expect(headline()).toBe(
    "M3 already has some of these folders. Check the changes below before copying.",
  );
  await click("Copy to M3");
  expect(names().filter((name) => name === "copyApprove")).toHaveLength(1);
  expect(names()).not.toContain("copyDecide");
});

it("leaves a full destination to its own alert after Replace all and names open choices", async () => {
  measuredWithoutSecrets();
  const diverged = newRow("repos/app", {
    status: "diverged",
    choices: ["keep-mine", "take-theirs", "leave-both"],
    needsDecision: true,
  });
  const open = copyStatus("previewed", {
    rows: [diverged],
    totals: { filesToMove: 1, bytesToMove: 10, bytesPresent: 0, decisionsNeeded: 1 },
  });
  statuses = [open, open];
  await mount();
  await click("Copy to M3");
  await click("Replace all");
  expect(container.textContent).toContain("Some items still need a choice below before copying.");
  statuses = [
    copyStatus("previewed", {
      rows: [{ ...diverged, decision: "take-theirs" }],
      disk: { needed: 2_000_000_000, free: 1_000_000_000 },
    }),
  ];
  await click("Replace all");
  expect(names()).not.toContain("copyApprove");
  const alerts = [...container.querySelectorAll('[role="alert"]')].map((node) => node.textContent);
  expect(alerts).toEqual(["M3 needs 2.0 GB free for this copy and has 1.0 GB."]);
  expect(pointerNow()).not.toHaveProperty("replaceAll");
});

it("does not promise to wait for idle work before transferring context", async () => {
  await mount();
  await selectMove();
  expect(container.textContent).toContain(
    "then transfers this coordinator's context and responsibility to M3 if work on M4 is idle; otherwise you retry once it is.",
  );
  expect(container.textContent).toContain(
    "Then transfers coordinator context if work on M4 is idle; otherwise you retry once it is.",
  );
  expect(container.textContent).not.toContain("when source work is idle");
});

const reopenMove = (overrides: Record<string, unknown> = {}) =>
  localStorage.setItem(
    "specwithcode:folder-copy:m4:source",
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-and-move",
      targetFolder: "/home/anton/project",
      projectId: "copied",
      ...overrides,
    }),
  );
const failedCheck = { repo: ".", ok: false, problems: ["git status differs from the source."] };

it.each([
  ["files changed while copying", { unstable: ["changing.ts"] }],
  ["a failed check", { checks: [failedCheck] }],
])("points a reopened move with %s only at Copy again", async (_label, problem) => {
  reopenMove();
  statuses = [copyStatus("applied", { mode: "copy-and-move", ...problem })];
  await mount();
  await settle();
  expect(container.querySelector('[data-slot="copy-problems"]')).not.toBeNull();
  expect(button("Copy again")).toBeTruthy();
  expect(() => button("Transfer coordinator context")).toThrow();
  expect(container.textContent).not.toContain("Transfer coordinator context when you are ready");
  // Copy again and Start a new copy both ask the source to release first.
  expect(button("Start a new copy").disabled).toBe(false);
  expect(names()).not.toContain("prepare");
});

const heldMove = (overrides: Record<string, unknown> = {}) =>
  copyStatus("failed", {
    mode: "copy-and-move",
    failedStep: "applied",
    committed: false,
    projectId: null,
    error: {
      code: "checks_failed",
      message:
        "The files are in place, but 1 repository differs from the source (the root), so the coordinator stayed on the source. Undo the copy, or retry to move it anyway.",
    },
    checks: [failedCheck],
    ...overrides,
  });
const footerLabels = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].map((node) =>
    node.textContent?.trim(),
  );

it("holds a move whose checks failed, leads with Copy again and keeps the coordinator on the source", async () => {
  reopenMove({ projectId: "00000000-0000-4000-8000-000000000002" });
  statuses = [heldMove()];
  await mount();
  await settle();
  const problems = container.querySelector('[data-slot="copy-problems"]');
  expect(problems?.textContent).toContain("the check of Root failed");
  expect(problems?.textContent).toContain("the coordinator stayed on M4");
  expect(problems?.querySelector('[aria-label="Problems in Root"]')?.textContent).toBe(
    "git status differs from the source.",
  );
  const labels = footerLabels();
  expect(labels.indexOf("Copy again")).toBeGreaterThanOrEqual(0);
  expect(labels.indexOf("Copy again")).toBeLessThan(labels.indexOf("Move anyway"));
  expect(labels).toContain("Undo…");
  expect(labels).not.toContain("Retry");
  expect(container.textContent).toContain("What happens next: Copy again");
  expect(container.textContent).not.toContain("Transfer coordinator context when you are ready");
  expect(names()).not.toContain("prepare");
});

it("moves a held copy anyway through retry and transfers context despite the differences", async () => {
  reopenMove({ projectId: "00000000-0000-4000-8000-000000000002" });
  const committed = copyStatus("applied", {
    mode: "copy-and-move",
    projectId: "00000000-0000-4000-8000-000000000002",
    checks: [failedCheck],
  });
  statuses = [heldMove()];
  state.handlers.copyRetry = () => committed;
  state.handlers.copyStatus = () => statuses.shift() ?? committed;
  await mount();
  await settle();
  await click("Move anyway");
  expect(names()).toContain("copyRetry");
  expect(names()).toContain("receive");
  expect(container.textContent).toContain("The coordinator continues on M3");
});

it("undoes a held copy from its problems screen", async () => {
  reopenMove({ projectId: "00000000-0000-4000-8000-000000000002" });
  statuses = [heldMove()];
  const undoResult = (undone: boolean) => ({
    status: undone ? copyStatus("undone", { mode: "copy-and-move" }) : heldMove(),
    items: [],
    edited: 0,
    undone,
    kept: [],
    problems: [],
  });
  state.handlers.copyUndo = ({ input }: any) => undoResult(!input.preview);
  await mount();
  await settle();
  await click("Undo…");
  expect(state.calls.find(([name]) => name === "copyUndo")![1]).toMatchObject({
    input: { preview: true, force: false },
  });
  await click("Undo the copy");
  expect(container.textContent).toContain("is back to how it was before the copy");
});

it("holds a fresh move whose checks failed instead of showing a bare error", async () => {
  statuses = [copyStatus("previewed", { mode: "copy-and-move" }), heldMove()];
  await mount();
  await selectMove();
  await click("Copy to M3");
  await click("Copy and transfer context to M3");
  expect(container.querySelector('[data-slot="copy-problems"]')?.textContent).toContain(
    "the coordinator stayed on M4",
  );
  expect(button("Copy again")).toBeTruthy();
  expect(button("Move anyway")).toBeTruthy();
  expect(names()).not.toContain("prepare");
});

it("records what Replace all leads to in the pointer", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", {
      rows: [
        filesConflict(
          [
            { id: "kept.txt", decision: "keep-mine" },
            { id: "open.txt", decision: null },
          ],
          3,
        ),
      ],
      totals: { filesToMove: 5, bytesToMove: 50, bytesPresent: 0, decisionsNeeded: 4 },
    }),
  ];
  state.handlers.copyStatus = () => statuses.shift() ?? copyStatus("scanning");
  await mount();
  await click("Copy to M3");
  await click("Replace all");
  expect(pointerNow()).toMatchObject({ replaceAll: true, replaceAllOutcome: "ask" });
});

it.each([
  ["ask", "Comparing again with your choices…"],
  [
    "copy-kept",
    "Comparing again, then copying with every other conflict replaced and your choices kept.",
  ],
  ["copy", "Comparing again, then copying with every conflict replaced."],
])("says what a reopened Replace all (%s) leads to while comparing", async (outcome, text) => {
  localStorage.setItem(
    "specwithcode:folder-copy:m4:source",
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
      auto: true,
      replaceAll: true,
      replaceAllOutcome: outcome,
    }),
  );
  measuredWithoutSecrets();
  state.handlers.copyStatus = () => copyStatus("scanning");
  await mount();
  await settle();
  expect(container.textContent).toContain(`What happens next: ${text}`);
});

it("remembers Move anyway when the context transfer after it is refused for now", async () => {
  reopenMove({ projectId: "00000000-0000-4000-8000-000000000002" });
  const committed = copyStatus("applied", {
    mode: "copy-and-move",
    projectId: "00000000-0000-4000-8000-000000000002",
    checks: [failedCheck],
  });
  statuses = [heldMove()];
  state.handlers.copyRetry = () => committed;
  state.handlers.copyStatus = () => statuses.shift() ?? committed;
  const prepare = state.handlers.prepare!;
  state.handlers.prepare = () => {
    throw Object.assign(new Error("busy"), { code: "busy" });
  };
  await mount();
  await settle();
  await click("Move anyway");
  expect(pointerNow()).toMatchObject({ moveAnyway: true });
  expect(container.textContent).toContain("Work is still running on M4");
  expect(container.textContent).toContain("You chose Move anyway");
  expect(() => button("Copy again")).toThrow();
  state.handlers.prepare = prepare;
  await click("Transfer coordinator context");
  expect(names()).toContain("receive");
  expect(container.textContent).toContain("The coordinator continues on M3");
  expect(pointerNow()).toBeNull();
});

it("offers the transfer again on a reopened move the person chose to move anyway", async () => {
  reopenMove({ projectId: "00000000-0000-4000-8000-000000000002", moveAnyway: true });
  statuses = [
    copyStatus("applied", {
      mode: "copy-and-move",
      projectId: "00000000-0000-4000-8000-000000000002",
      checks: [failedCheck],
    }),
  ];
  await mount();
  await settle();
  expect(container.textContent).toContain("Transfer coordinator context when you are ready");
  expect(() => button("Copy again")).toThrow();
  expect(names()).not.toContain("prepare");
  await click("Transfer coordinator context");
  expect(names()).toContain("receive");
  expect(container.textContent).toContain("The coordinator continues on M3");
});

it("releases the source operation after undoing a held, uncommitted move", async () => {
  reopenMove({ projectId: "00000000-0000-4000-8000-000000000002" });
  statuses = [heldMove()];
  state.handlers.copyUndo = ({ input }: any) => ({
    status: input.preview ? heldMove() : copyStatus("undone", { mode: "copy-and-move" }),
    items: [],
    edited: 0,
    undone: !input.preview,
    kept: [],
    problems: [],
  });
  await mount();
  await settle();
  await click("Undo…");
  expect(names()).not.toContain("copySourceCancel");
  await click("Undo the copy");
  expect(container.textContent).toContain("is back to how it was before the copy");
  const operationId = "00000000-0000-4000-8000-000000000009";
  expect(state.calls.find(([name]) => name === "copySourceCancel")![1]).toMatchObject({
    environmentId: "m4",
    input: { operationId },
  });
  expect(state.calls.find(([name]) => name === "copyRelease")![1]).toMatchObject({
    environmentId: "m4",
    input: { projectId: "source", operationId },
  });
  expect(names().indexOf("copyUndo")).toBeLessThan(names().indexOf("copySourceCancel"));
  expect(pointerNow()).toBeNull();
});

it("keeps the pointer when the source refuses to release after an undo", async () => {
  reopenMove({ projectId: "00000000-0000-4000-8000-000000000002" });
  statuses = [heldMove()];
  state.handlers.copyUndo = ({ input }: any) => ({
    status: input.preview ? heldMove() : copyStatus("undone", { mode: "copy-and-move" }),
    items: [],
    edited: 0,
    undone: !input.preview,
    kept: [],
    problems: [],
  });
  state.handlers.copyRelease = () => {
    throw new Error("The source could not release the operation.");
  };
  await mount();
  await settle();
  await click("Undo…");
  await click("Undo the copy");
  expect(container.textContent).toContain("is back to how it was before the copy");
  expect(container.textContent).toContain("The source could not release the operation.");
  expect(pointerNow()).toMatchObject({ operationId: "00000000-0000-4000-8000-000000000009" });
});

it("does not cancel the source after undoing a committed copy", async () => {
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  state.handlers.copyUndo = ({ input }: any) => ({
    status: input.preview ? copyStatus("applied") : copyStatus("undone"),
    items: [],
    edited: 0,
    undone: !input.preview,
    kept: [],
    problems: [],
  });
  await mount();
  await click("Copy to M3");
  await click("Copy to M3");
  await click("Undo…");
  await click("Undo the copy");
  expect(container.textContent).toContain("is back to how it was before the copy");
  expect(names()).not.toContain("copySourceCancel");
  expect(names()).not.toContain("copyRelease");
});
