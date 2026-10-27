// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  copyHandlers,
  CopyFixture,
  copyStatus,
  findButton,
  newRow,
  noSecrets,
  stepState,
  type FixtureOptions,
} from "./HandoffFolderCopy.testkit";

// The step bar as a wizard: passed steps open a read-only look, and looking never acts.
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
vi.mock("./ProjectLinkDialog", () => ({ ProjectLinkDialog: () => null }));
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
  MachineReadinessChecklist: () => null,
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
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const button = (label: string) => findButton(document, label);
const click = async (label: string) => {
  await act(async () => button(label).click());
  await settle();
};
const mount = (overrides: FixtureOptions = {}) =>
  act(async () => root.render(<CopyFixture {...overrides} />));
const step = (id: string) => {
  const element = document.querySelector<HTMLButtonElement>(
    `[data-slot="copy-step"][data-step-id="${id}"]`,
  );
  if (!element) throw new Error(`Missing step ${id}`);
  return element;
};
const openStep = async (id: string) => {
  await act(async () => step(id).click());
  await settle();
};
/** Each step id with whether its button can be clicked. */
const clickable = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-slot="copy-step"]')].map(
    (element) => `${element.getAttribute("data-step-id")}:${element.disabled ? "off" : "on"}`,
  );
const banner = () => document.querySelector('[data-slot="copy-viewing"]')?.textContent ?? null;
const pageText = () => document.body.textContent ?? "";
const chooseFirst = () =>
  act(async () =>
    document
      .querySelector<HTMLElement>('[data-slot="copy-choose-first"] [data-slot="checkbox"]')!
      .click(),
  );
const names = () => state.calls.map(([name]) => name);
const KEY = "specwithcode:folder-copy:m4:source";
const pointerNow = () => JSON.parse(localStorage.getItem(KEY) ?? "null");
const folderInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Folder on M3"]')!;
const editFolder = (value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      folderInput(),
      value,
    );
    folderInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
const moveRadio = () =>
  [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) =>
    node.closest("label")?.textContent?.includes("Copy and transfer coordinator context"),
  )!;
const untracked = () =>
  document.querySelector<HTMLElement>('[data-class="untracked"] [data-slot="checkbox"]')!;
const stageNow = () =>
  container.querySelector('[data-slot="handoff-folder-copy"]')?.getAttribute("data-stage");
/** The change buttons a review can offer; none of them should show after Apply. */
const CHANGES = [
  "Change where (cancels this copy)",
  "Change what to copy (measures again)",
  "Change folder",
];
const measuredWithoutSecrets = () => {
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = (input) => ({
    ...(offer(input) as object),
    status: { state: "scanned", summary: noSecrets, error: null },
  });
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

it("shows a one-click copy's skipped steps as done and automatic, and opens each read-only", async () => {
  measuredWithoutSecrets();
  // The destination keeps the compared rows on every later status.
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  await mount();
  await click("Copy to M3");
  expect(stepState()).toEqual([
    "Where:done",
    "What:done",
    "Review:done",
    "Copy:done",
    "Done:current",
  ]);
  expect(step("what").getAttribute("data-auto")).toBe("true");
  expect(step("review").getAttribute("data-auto")).toBe("true");
  expect(step("what").getAttribute("aria-label")).toBe("What, chosen automatically");
  expect(step("copy").hasAttribute("data-auto")).toBe(false);
  expect(clickable()).toEqual(["where:on", "what:on", "review:on", "copy:on", "done:off"]);
  const calls = state.calls.length;

  await openStep("what");
  expect(banner()).toBe("You're viewing What. The copy is at Done.");
  expect(step("what").getAttribute("data-viewing")).toBe("true");
  expect(clickable()).toEqual(["where:on", "what:off", "review:on", "copy:on", "done:on"]);
  const classes = document.querySelector<HTMLFieldSetElement>('[data-slot="copy-classes"]')!;
  expect(classes.disabled).toBe(true);
  expect(document.querySelector('[data-slot="copy-review-auto"]')?.textContent).toBe(
    "Chosen automatically. Turn on Choose what to copy to pick these yourself.",
  );
  // The live Done actions are hidden while looking back.
  expect(pageText()).not.toContain("M3 has a copy in");
  expect(() => button("Open on M3")).toThrow();

  await openStep("review");
  expect(banner()).toBe("You're viewing Review. The copy is at Done.");
  expect(document.querySelector('[data-slot="copy-review-plan"]')?.textContent).toBe(
    "Plan as approved.Nothing on M3 would be replaced, so it was approved automatically.",
  );
  expect(document.querySelectorAll('[data-slot="copy-row"]')).toHaveLength(1);

  await openStep("copy");
  expect(document.querySelector('[data-slot="copy-review-copied"]')?.textContent).toBe(
    "5 files (50 B) copied to /Users/me/Projects/project on M3.",
  );

  await click("Go to Done");
  expect(banner()).toBeNull();
  expect(pageText()).toContain("M3 has a copy in /Users/me/Projects/project");
  expect(button("Open on M3")).toBeTruthy();
  // Looking at steps never called a machine.
  expect(state.calls).toHaveLength(calls);
});

it("opens Where read-only while choosing and comes back to What with the choice kept", async () => {
  await mount();
  await chooseFirst();
  await click("Measure the folder");
  expect(stepState()).toEqual([
    "Where:done",
    "What:current",
    "Review:next",
    "Copy:next",
    "Done:next",
  ]);
  // The live step and every future step are not buttons that do anything yet.
  expect(clickable()).toEqual(["where:on", "what:off", "review:off", "copy:off", "done:off"]);
  const untracked = () =>
    document.querySelector<HTMLElement>('[data-class="untracked"] [data-slot="checkbox"]')!;
  await act(async () => untracked().click());
  expect(untracked().getAttribute("aria-checked")).toBe("false");
  const calls = state.calls.length;

  await openStep("where");
  expect(banner()).toBe("You're viewing Where. The copy is at What.");
  const folder = document.querySelector<HTMLInputElement>('input[aria-label="Folder on M3"]')!;
  expect(folder.value).toBe("/home/anton/Projects/project");
  expect(folder.disabled).toBe(true);
  expect(clickable()).toEqual(["where:off", "what:on", "review:off", "copy:off", "done:off"]);
  expect(() => button("Preview on M3")).toThrow();
  expect(() => button("Cancel copy")).toThrow();

  await click("Go to What");
  expect(banner()).toBeNull();
  expect(untracked().getAttribute("aria-checked")).toBe("false");
  expect(button("Preview on M3").disabled).toBe(false);
  expect(state.calls).toHaveLength(calls);
});

it("returns to the live step from the step bar too", async () => {
  await mount();
  await chooseFirst();
  await click("Measure the folder");
  await openStep("where");
  expect(banner()).not.toBeNull();
  await openStep("what");
  expect(banner()).toBeNull();
  expect(button("Preview on M3")).toBeTruthy();
});

it("puts Go to in the dialog footer and keeps live actions out of a review", async () => {
  await mount({ dialog: true });
  await chooseFirst();
  await click("Measure the folder");
  await openStep("where");
  const back = button("Go to What");
  expect(back.closest('[data-slot="dialog-footer"]')).not.toBeNull();
  expect(back.closest('[data-slot="scroll-area-viewport"]')).toBeNull();
  expect(() => button("Preview on M3")).toThrow();
  await act(async () => back.click());
  await settle();
  expect(button("Preview on M3").closest('[data-slot="dialog-footer"]')).not.toBeNull();
});

it("marks Review as yours when a one-click copy stopped at the preview", async () => {
  await mount();
  await click("Copy to M3");
  await click("Copy to M3");
  expect(stepState().at(-1)).toBe("Done:current");
  expect(step("what").getAttribute("data-auto")).toBe("true");
  expect(step("review").hasAttribute("data-auto")).toBe(false);
  await openStep("review");
  expect(document.querySelector('[data-slot="copy-review-plan"]')?.textContent).toBe(
    "Plan as approved.",
  );
});

it("locks every step while coordinator context transfers", async () => {
  state.handlers.prepare = () => new Promise(() => {});
  statuses = [
    copyStatus("previewed", { mode: "copy-and-move" }),
    copyStatus("applied", {
      mode: "copy-and-move",
      projectId: "00000000-0000-4000-8000-000000000002",
    }),
  ];
  await mount();
  const move = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((node) =>
    node.closest("label")?.textContent?.includes("Copy and transfer coordinator context"),
  )!;
  await act(async () => move.click());
  await click("Copy to M3");
  await click("Copy and transfer context to M3");
  expect(
    container.querySelector('[data-slot="handoff-folder-copy"]')?.getAttribute("data-stage"),
  ).toBe("moving");
  expect(stepState()).toEqual([
    "Where:done",
    "What:done",
    "Review:done",
    "Copy:done",
    "Transfer:current",
    "Done:next",
  ]);
  expect(clickable()).toEqual([
    "where:off",
    "what:off",
    "review:off",
    "copy:off",
    "transfer:off",
    "done:off",
  ]);
  expect(button("Back").disabled).toBe(true);
});

it("marks the step a copy stopped at", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", { rows: [newRow(".")] }),
    copyStatus("failed", {
      rows: [newRow(".")],
      failedStep: "transferring",
      error: { message: "Disk full." },
    }),
  ];
  await mount();
  await click("Copy to M3");
  expect(
    container.querySelector('[data-slot="handoff-folder-copy"]')?.getAttribute("data-stage"),
  ).toBe("failed");
  expect(step("copy").getAttribute("data-state")).toBe("current");
  expect(step("copy").getAttribute("data-tone")).toBe("failed");
  expect(step("copy").getAttribute("aria-label")).toBe("Copy, stopped");
  expect(step("review").hasAttribute("data-tone")).toBe(false);
  expect(clickable()).toEqual(["where:on", "what:on", "review:on", "copy:off", "done:off"]);
});

it("puts Back first in the dialog footer and looks back without calling a machine", async () => {
  await mount({ dialog: true });
  await chooseFirst();
  await click("Measure the folder");
  const back = button("Back");
  expect(back.getAttribute("data-slot")).toBe("copy-back");
  expect(back.className).toContain("mr-auto");
  expect(back.closest('[data-slot="dialog-footer"]')).not.toBeNull();
  expect(back.parentElement?.querySelector("button")).toBe(back);
  const calls = state.calls.length;

  await act(async () => back.click());
  await settle();
  expect(banner()).toBe("You're viewing Where. The copy is at What.");
  // Where has no step before it.
  expect(() => button("Back")).toThrow();
  expect(() => button("Cancel copy")).toThrow();
  await click("Go to What");
  expect(button("Preview on M3").disabled).toBe(false);
  expect(state.calls).toHaveLength(calls);
});

it("offers no Back on Where", async () => {
  await mount();
  expect(() => button("Back")).toThrow();
});

it("measures again to change what to copy after the compare, keeping the choice", async () => {
  await mount();
  await chooseFirst();
  await click("Measure the folder");
  await act(async () => untracked().click());
  await click("Preview on M3");
  expect(stageNow()).toBe("preview");
  const first = pointerNow().operationId;

  await click("Back");
  expect(banner()).toBe("You're viewing What. The copy is at Review.");
  // Looking at What before Apply offers the one change it can make, and says what it costs.
  expect(() => button("Change where (cancels this copy)")).toThrow();
  const before = state.calls.length;
  await click("Change what to copy (measures again)");
  const after = names().slice(before);
  expect(after.slice(0, 3)).toEqual(["copyCancel", "copySourceCancel", "copyOffer"]);
  expect(state.calls.find(([name]) => name === "copyCancel")![1]).toMatchObject({
    environmentId: "m3",
    input: { operationId: first },
  });
  const offered = state.calls.findLast(([name]) => name === "copyOffer")![1] as {
    input: { operationId: string };
  };
  expect(offered.input.operationId).not.toBe(first);
  expect(pointerNow()).toMatchObject({ operationId: offered.input.operationId });
  expect(pointerNow()).not.toHaveProperty("auto");
  expect(stageNow()).toBe("select");
  expect(banner()).toBeNull();
  expect(untracked().getAttribute("aria-checked")).toBe("false");
  expect(button("Preview on M3").disabled).toBe(false);
});

it("cancels the copy to change where, and opens the form with the same choices", async () => {
  await mount();
  await act(async () => moveRadio().click());
  await chooseFirst();
  await click("Measure the folder");
  await click("Preview on M3");
  await click("Back");
  await click("Back");
  expect(banner()).toBe("You're viewing Where. The copy is at Review.");
  expect(() => button("Change folder")).toThrow();
  await click("Change where (cancels this copy)");
  expect(names()).toContain("copyCancel");
  expect(names()).toContain("copySourceCancel");
  expect(names()).toContain("copyRelease");
  expect(pointerNow()).toBeNull();
  expect(stageNow()).toBe("setup");
  expect(banner()).toBeNull();
  expect(document.querySelector('[data-slot="copy-cancelled"]')?.textContent).toBe(
    "Copy cancelled. Nothing on M3 changed.",
  );
  expect(folderInput().disabled).toBe(false);
  expect(folderInput().value).toBe("/home/anton/Projects/project");
  expect(moveRadio().getAttribute("aria-checked")).toBe("true");
  expect(button("Measure the folder").disabled).toBe(false);
  // Closing right after keeps those choices for the next open.
  expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toMatchObject({
    machine: "m3",
    folder: "/home/anton/Projects/project",
    mode: "copy-and-move",
    chooseFirst: true,
  });
});

it("saves a new folder while choosing without measuring again", async () => {
  await mount();
  await act(async () => moveRadio().click());
  await chooseFirst();
  await click("Measure the folder");
  const { operationId, projectId } = pointerNow();
  await openStep("where");
  // Read-only until the person asks to change the folder.
  expect(folderInput().disabled).toBe(true);
  expect(() => button("Change where (cancels this copy)")).toThrow();
  await click("Change folder");
  expect(folderInput().disabled).toBe(false);
  expect(button("Save folder").disabled).toBe(true);
  await editFolder("relative/path");
  await click("Save folder");
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Enter the full absolute path of the folder on the destination machine.",
  );
  expect(pointerNow().targetFolder).toBe("/home/anton/Projects/project");

  await editFolder("/home/anton/Elsewhere/project");
  await click("Save folder");
  expect(banner()).toBeNull();
  expect(stageNow()).toBe("select");
  expect(pointerNow()).toMatchObject({
    operationId,
    targetFolder: "/home/anton/Elsewhere/project",
  });
  // A move registers the copy for the new folder under a fresh id.
  expect(pointerNow().projectId).not.toBe(projectId);
  expect(names().filter((name) => name === "copyOffer")).toHaveLength(1);
  expect(names()).not.toContain("copySourceCancel");

  await click("Preview on M3");
  const started = state.calls.find(([name]) => name === "copyStart")![1] as {
    input: { targetFolder: string; projectId: string };
  };
  expect(started.input).toMatchObject({
    targetFolder: "/home/anton/Elsewhere/project",
    projectId: pointerNow().projectId,
  });
});

it("keeps earlier steps read-only after Apply and starts a new copy with the same settings", async () => {
  measuredWithoutSecrets();
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  await mount();
  await click("Copy to M3");
  expect(stepState().at(-1)).toBe("Done:current");
  await click("Back");
  expect(banner()).toBe("You're viewing Copy. The copy is at Done.");
  for (const id of ["copy", "review", "what"]) {
    await openStep(id);
    for (const label of [...CHANGES, "Start a new copy with these settings"])
      expect(() => button(label)).toThrow();
  }
  await openStep("where");
  for (const label of CHANGES) expect(() => button(label)).toThrow();
  const calls = state.calls.length;
  await click("Start a new copy with these settings");
  expect(stageNow()).toBe("setup");
  expect(banner()).toBeNull();
  expect(pointerNow()).toBeNull();
  expect(folderInput().value).toBe("/Users/me/Projects/project");
  expect(button("Copy to M3").disabled).toBe(false);
  // Nothing was measured or cancelled.
  expect(names().slice(calls)).toEqual([]);
});

it("keeps a failed copy read-only once it reached Apply", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", { rows: [newRow(".")] }),
    copyStatus("failed", {
      rows: [newRow(".")],
      failedStep: "applying",
      error: { message: "Disk full." },
    }),
  ];
  await mount();
  await click("Copy to M3");
  expect(stageNow()).toBe("failed");
  await click("Back");
  await click("Back");
  expect(banner()).toBe("You're viewing What. The copy is at Copy.");
  for (const label of CHANGES) expect(() => button(label)).toThrow();
  await openStep("where");
  for (const label of CHANGES) expect(() => button(label)).toThrow();
  // A partly applied copy is never dropped from a review: Retry is on the live step.
  expect(() => button("Start a new copy with these settings")).toThrow();
  await click("Go to Copy");
  expect(button("Retry").disabled).toBe(false);
});

it("offers to change where on a copy that failed before Apply", async () => {
  measuredWithoutSecrets();
  statuses = [
    copyStatus("previewed", { rows: [newRow(".")] }),
    copyStatus("failed", {
      rows: [newRow(".")],
      failedStep: "transferring",
      error: { message: "Disk full." },
    }),
  ];
  await mount();
  await click("Copy to M3");
  await openStep("where");
  expect(() => button("Start a new copy with these settings")).toThrow();
  await click("Change where (cancels this copy)");
  expect(names()).toContain("copySourceCancel");
  expect(stageNow()).toBe("setup");
  expect(pointerNow()).toBeNull();
});

it("locks starting a new copy while a coordinator transfer may need recovering", async () => {
  const applied = copyStatus("applied", {
    mode: "copy-and-move",
    projectId: "00000000-0000-4000-8000-000000000009",
    rows: [newRow(".")],
  });
  statuses = [applied];
  state.handlers.copySourceStatus = () => ({ state: "scanned", summary: noSecrets, error: null });
  localStorage.setItem(
    KEY,
    JSON.stringify({
      operationId: applied.operationId,
      environmentId: "m3",
      mode: "copy-and-move",
      targetFolder: "/Users/me/Projects/project",
      projectId: applied.projectId,
      selection: applied.selection,
    }),
  );
  await mount();
  await settle();
  expect(stepState()).toContain("Transfer:current");
  await openStep("where");
  expect(button("Start a new copy with these settings").disabled).toBe(true);
});

// Reopening: the dialog checks the copy first, then brings back the step that was on screen.
const LAST_KEY = "specwithcode:folder-copy-last:m4:source";
const DRAFT_KEY = "specwithcode:folder-copy-draft:m4:source";
const reopen = async () => {
  await act(async () => root.unmount());
  state.calls = [];
  root = createRoot(container);
  await mount();
};
const noteText = () =>
  document.querySelector('[data-slot="copy-resume-note"]')?.textContent ?? null;
const checkingText = () =>
  document.querySelector('[data-slot="copy-checking"]')?.textContent ?? null;
const measured = () => {
  state.handlers.copySourceStatus = () => ({
    state: "scanned",
    summary: noSecrets,
    progress: null,
    error: null,
  });
};
/** A copy that stops to choose, compared and waiting at its preview. */
const toPreview = async () => {
  measuredWithoutSecrets();
  measured();
  await mount();
  await chooseFirst();
  await click("Measure the folder");
  await click("Preview on M3");
  expect(stageNow()).toBe("preview");
};

it("shows Checking while a reopened copy waits for the destination, with no form or buttons", async () => {
  await toPreview();
  expect(pointerNow()).toMatchObject({ seen: "review", viewed: "review" });
  let answer: (value: unknown) => void = () => {};
  state.handlers.copyStatus = () => new Promise((resolve) => (answer = resolve));
  await reopen();
  await settle();
  expect(checkingText()).toBe("Checking the copy to /home/anton/Projects/project on M3…");
  expect(folderInput()).toBeNull();
  expect(document.querySelectorAll('[data-slot="copy-actions"] button')).toHaveLength(0);
  // The bar holds the step last seen, and nothing in it opens while checking.
  expect(stepState()).toEqual([
    "Where:done",
    "What:done",
    "Review:current",
    "Copy:next",
    "Done:next",
  ]);
  expect(clickable()).toEqual(["where:off", "what:off", "review:off", "copy:off", "done:off"]);

  await act(async () => answer(copyStatus("previewed")));
  await settle();
  expect(checkingText()).toBeNull();
  expect(stageNow()).toBe("preview");
  expect(noteText()).toBeNull();
  expect(banner()).toBeNull();
  expect(button("Copy to M3").disabled).toBe(false);
});

it("comes back to the step that was on screen when the copy is where it was", async () => {
  await toPreview();
  await click("Back");
  expect(pointerNow()).toMatchObject({ seen: "review", viewed: "what" });
  state.handlers.copyStatus = () => copyStatus("previewed");
  await reopen();
  await settle();
  expect(noteText()).toBe("Picked up where you left off.");
  expect(banner()).toBe("You're viewing What. The copy is at Review.");
  expect(document.querySelector<HTMLFieldSetElement>('[data-slot="copy-classes"]')!.disabled).toBe(
    true,
  );
  await click("Go to Review");
  expect(noteText()).toBeNull();
  expect(banner()).toBeNull();
  expect(pointerNow()).toMatchObject({ viewed: "review" });
});

it("says a copy finished while closed, then keeps it as the last copy with View and Undo", async () => {
  await toPreview();
  state.handlers.copyStatus = () => copyStatus("applied");
  await reopen();
  await settle();
  expect(stageNow()).toBe("done");
  expect(noteText()).toBe("This copy finished while the window was closed.");
  expect(state.link).toHaveBeenCalledOnce();
  expect(pointerNow()).toMatchObject({ seen: "done", doneSeen: true, linked: true });

  // Done was seen: the next reopen starts a new copy and keeps this one one click away.
  await reopen();
  await settle();
  expect(stageNow()).toBe("setup");
  expect(pointerNow()).toBeNull();
  expect(names()).not.toContain("copyStatus");
  expect(document.querySelector('[data-slot="copy-last"]')?.textContent).toBe(
    "The last copy to /home/anton/Projects/project on M3 finished. View it to undo it.View",
  );
  // The form starts from the last copy's choices.
  expect(folderInput().value).toBe("/home/anton/Projects/project");
  expect(button("Measure the folder").disabled).toBe(false);

  state.handlers.copyUndo = ({ input }: any) => ({
    status: input.preview ? copyStatus("applied") : copyStatus("undone"),
    items: [],
    edited: 0,
    undone: !input.preview,
    kept: [],
    problems: [],
  });
  await click("View");
  expect(stageNow()).toBe("done");
  expect(localStorage.getItem(LAST_KEY)).toBeNull();
  // It was linked before; a reopen does not link it again.
  expect(state.link).toHaveBeenCalledOnce();
  await click("Undo…");
  await click("Undo the copy");
  expect(pageText()).toContain("is back to how it was before the copy");
  expect(pointerNow()).toBeNull();
});

it("does not mark Done seen while the copy still needs linking", async () => {
  measuredWithoutSecrets();
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  state.link = vi.fn(async () => ({ status: "review", reason: "Notes differ." }));
  await mount();
  await click("Copy to M3");
  expect(stageNow()).toBe("done");
  expect(pageText()).toContain("Not linked yet. Notes differ.");
  expect(pointerNow()?.doneSeen).toBeUndefined();
  // The reopen checks the copy again and links it, instead of archiving it unlinked.
  statuses = [copyStatus("applied", { rows })];
  state.handlers.copySourceStatus = () => ({ state: "scanned", summary: noSecrets, error: null });
  await reopen();
  await settle();
  expect(state.link).toHaveBeenCalledTimes(2);
  expect(stageNow()).toBe("done");
  expect(pointerNow()).not.toBeNull();
});

it("does not mark Done seen while linking is still running", async () => {
  measuredWithoutSecrets();
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  state.link = vi.fn(() => new Promise(() => {}));
  await mount();
  await click("Copy to M3");
  expect(stageNow()).toBe("done");
  expect(state.link).toHaveBeenCalledOnce();
  expect(pointerNow()?.doneSeen).toBeUndefined();
});

it("says Retry before Apply starts the copy again, and notes it on What", async () => {
  await toPreview();
  statuses = [
    copyStatus("failed", {
      failedStep: "transferring",
      error: { message: "The copy connection was interrupted." },
    }),
  ];
  await click("Copy to M3");
  expect(stageNow()).toBe("failed");
  expect(document.querySelector('[data-slot="copy-next"]')?.textContent).toBe(
    "What happens next: Retry starts the copy again: it measures again, then you choose what to copy and preview it. Nothing on M3 changed, so Cancel copy leaves it as it was.",
  );
  statuses = [copyStatus("previewed")];
  await click("Retry");
  expect(stageNow()).toBe("select");
  expect(noteText()).toBe("Retry started this copy again from the beginning.");
  await click("Preview on M3");
  expect(stageNow()).toBe("preview");
  expect(noteText()).toBeNull();
  // The note was for that restart only: a later copy does not repeat it.
  await openStep("what");
  await click("Go to Review");
  expect(noteText()).toBeNull();
});

it("keeps the step last seen when the destination does not answer, with Check again", async () => {
  await toPreview();
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("M3 is offline."), {
      _tag: "FolderCopyError",
      code: "unreachable",
    });
  };
  await reopen();
  await settle();
  expect(stepState()).toContain("Review:current");
  expect(checkingText()).toBe(
    "A copy to /home/anton/Projects/project on M3 is unfinished. Check it again once M3 is reachable.",
  );
  expect(folderInput()).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("M3 is offline.");
  expect(pointerNow()).toMatchObject({ seen: "review" });

  state.handlers.copyStatus = () => copyStatus("previewed");
  await click("Check the copy again");
  expect(checkingText()).toBeNull();
  expect(stageNow()).toBe("preview");
  expect(button("Copy to M3").disabled).toBe(false);
});

it("shows an old pointer's live step as before, and starts remembering it", async () => {
  measured();
  localStorage.setItem(
    KEY,
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "m3",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
    }),
  );
  state.handlers.copyStatus = () => copyStatus("previewed");
  await mount();
  await settle();
  expect(stageNow()).toBe("preview");
  expect(noteText()).toBeNull();
  expect(banner()).toBeNull();
  expect(pointerNow()).toMatchObject({ seen: "review", viewed: "review" });
});

it("remembers the setup form while no copy has started", async () => {
  await mount();
  await chooseFirst();
  await act(async () => moveRadio().click());
  await editFolder("/home/anton/Elsewhere/project");
  expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toEqual({
    machine: "m3",
    folder: "/home/anton/Elsewhere/project",
    mode: "copy-and-move",
    chooseFirst: true,
  });
  await reopen();
  await settle();
  expect(folderInput().value).toBe("/home/anton/Elsewhere/project");
  expect(moveRadio().getAttribute("aria-checked")).toBe("true");
  await click("Measure the folder");
  // The copy's pointer holds the choices from here.
  expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  expect(pointerNow()).toMatchObject({ targetFolder: "/home/anton/Elsewhere/project" });
});

it("keeps a finished copy as the last copy when a new one starts from Done", async () => {
  measuredWithoutSecrets();
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  await mount();
  await click("Copy to M3");
  expect(stageNow()).toBe("done");
  await click("Start a new copy");
  expect(pointerNow()).toBeNull();
  expect(JSON.parse(localStorage.getItem(LAST_KEY)!)).toMatchObject({
    targetFolder: "/home/anton/Projects/project",
    auto: true,
  });
  expect(document.querySelector('[data-slot="copy-last"]')).not.toBeNull();
  expect(button("Copy to M3").disabled).toBe(false);
});

it("keeps Review as yours after a reopen when the plan was shown", async () => {
  measured();
  await mount();
  await click("Copy to M3");
  expect(stageNow()).toBe("preview");
  expect(pointerNow()).toMatchObject({ planShown: true });
  // Approved, then closed: the reopen never shows the preview again.
  state.handlers.copyStatus = () => copyStatus("applied");
  await reopen();
  await settle();
  expect(stageNow()).toBe("done");
  expect(step("what").getAttribute("data-auto")).toBe("true");
  expect(step("review").hasAttribute("data-auto")).toBe(false);
  await openStep("review");
  expect(document.querySelector('[data-slot="copy-review-plan"]')?.textContent).toBe(
    "Plan as approved.",
  );
});

it("lets the last copy go back to being the last copy when its destination is offline", async () => {
  measuredWithoutSecrets();
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  await mount();
  await click("Copy to M3");
  await click("Start a new copy");
  expect(localStorage.getItem(LAST_KEY)).not.toBeNull();
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("M3 is offline."), {
      _tag: "FolderCopyError",
      code: "unreachable",
    });
  };
  await click("View");
  expect(checkingText()).toBe(
    "A copy to /home/anton/Projects/project on M3 is unfinished. Check it again once M3 is reachable.",
  );
  expect(pointerNow()).toMatchObject({ reopened: true });
  await click("Start a new copy");
  expect(checkingText()).toBeNull();
  expect(stageNow()).toBe("setup");
  expect(pointerNow()).toBeNull();
  expect(JSON.parse(localStorage.getItem(LAST_KEY)!)).not.toHaveProperty("reopened");
  expect(document.querySelector('[data-slot="copy-last"]')).not.toBeNull();
  expect(button("Copy to M3").disabled).toBe(false);
});

it("offers only Check again for an unfinished copy whose destination is offline", async () => {
  await toPreview();
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("M3 is offline."), {
      _tag: "FolderCopyError",
      code: "unreachable",
    });
  };
  await reopen();
  await settle();
  expect(checkingText()).not.toBeNull();
  expect(() => button("Start a new copy")).toThrow();
});

it("says a copy cancelled elsewhere copied nothing", async () => {
  await toPreview();
  state.handlers.copyStatus = () =>
    copyStatus("cancelled", { committed: true, rows: [newRow(".")] });
  await reopen();
  await settle();
  expect(stageNow()).toBe("undone");
  expect(document.querySelector('[data-slot="copy-undone"]')?.textContent).toContain(
    "The copy was cancelled.",
  );
  await openStep("review");
  expect(document.querySelector('[data-slot="copy-review-plan"]')?.textContent).toBe(
    "Plan as compared.",
  );
  await openStep("copy");
  expect(document.querySelector('[data-slot="copy-review-copied"]')?.textContent).toBe(
    "The copy was cancelled. Nothing in /Users/me/Projects/project on M3 changed.",
  );
});

it("brings back a What review once the folder summary loads on a reopen", async () => {
  await toPreview();
  await click("Back");
  expect(pointerNow()).toMatchObject({ seen: "review", viewed: "what" });
  let loaded: (value: unknown) => void = () => {};
  const summary = new Promise((resolve) => (loaded = resolve));
  state.handlers.copySourceStatus = () => summary;
  // Comparing again: the restore fires from the poll, before the summary arrives.
  state.handlers.copyStatus = () => copyStatus("scanning");
  await reopen();
  await settle();
  expect(checkingText()).toBeNull();
  await act(async () =>
    loaded({ state: "scanned", summary: noSecrets, progress: null, error: null }),
  );
  await settle();
  expect(banner()).toBe("You're viewing What. The copy is at Review.");
  expect(noteText()).toBe("Picked up where you left off.");
});
