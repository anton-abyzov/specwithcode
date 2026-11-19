// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { linkRefusalsForTest, resetLinkRefusalsForTest } from "../../studio/linkRefusals";
import {
  copyHandlers,
  CopyFixture,
  copyStatus,
  findButton,
  isDisabled,
  moreItems,
  MOVE,
  newRow,
  noSecrets,
  openMore,
  stepState,
  type FixtureOptions,
} from "./HandoffFolderCopy.testkit";

// The step line shows progress only; Your choices holds the one way to change the copy.
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
// The credentials list has its own test (CopyCredentialsChecklist.test.tsx).
vi.mock("./CopyCredentialsChecklist", () => ({ CopyCredentialsChecklist: () => null }));
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
  const element = document.querySelector<HTMLElement>(
    `[data-slot="copy-step"][data-step-id="${id}"]`,
  );
  if (!element) throw new Error(`Missing step ${id}`);
  return element;
};
const hasStep = (id: string) =>
  document.querySelector(`[data-slot="copy-step"][data-step-id="${id}"]`) !== null;
const changeLink = () => document.querySelector<HTMLButtonElement>('[data-slot="copy-change"]');
const pageText = () => document.body.textContent ?? "";
const chooseFirst = () =>
  act(async () =>
    document
      .querySelector<HTMLElement>('[data-slot="copy-choose-first"] [data-slot="checkbox"]')!
      .click(),
  );
const names = () => state.calls.map(([name]) => name);
const KEY = "specwithcode:folder-copy:laptopE:source";
const pointerNow = () => JSON.parse(localStorage.getItem(KEY) ?? "null");
const folderInput = () =>
  document.querySelector<HTMLInputElement>('input[aria-label="Folder on Kiosk D"]')!;
const editFolder = (value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      folderInput(),
      value,
    );
    folderInput().dispatchEvent(new Event("input", { bubbles: true }));
  });
const stageNow = () =>
  container.querySelector('[data-slot="handoff-folder-copy"]')?.getAttribute("data-stage");
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
  state.homes = { kioskD: "/home/sam", deskB: "/Users/sam" };
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
  resetLinkRefusalsForTest();
  await act(async () => root.unmount());
  container.remove();
});

it("leaves a one-click copy's skipped steps off the line, with nothing to click", async () => {
  measuredWithoutSecrets();
  // The destination keeps the compared rows on every later status.
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  await mount();
  await click("Copy to Kiosk D");
  expect(stepState()).toEqual(["Where:done", "Copy:done", "Done:current"]);
  expect(hasStep("what")).toBe(false);
  expect(hasStep("review")).toBe(false);
  // The line shows progress only: no step is a button.
  expect(document.querySelectorAll('[data-slot="copy-steps"] button')).toHaveLength(0);
  expect(pageText()).toContain("Project is on Kiosk D. The coordinator stays here.");
  expect(button("Open on Kiosk D")).toBeTruthy();
});

it("shows Your choices while choosing, with one Change link that stops the copy", async () => {
  await mount();
  await chooseFirst();
  await click("Copy to Kiosk D");
  expect(stepState()).toEqual([
    "Where:done",
    "What:current",
    "Review:next",
    "Copy:next",
    "Done:next",
  ]);
  const choices = document.querySelector('[data-slot="copy-choices"]')!;
  expect(choices.textContent).toContain("Copy to Kiosk D: /home/sam/Projects/project");
  expect(choices.textContent).toContain("Copy the whole folder from Laptop E");
  expect(choices.querySelectorAll("button")).toHaveLength(1);
  expect(changeLink()?.textContent).toBe("Change (stops this copy)");
  expect(changeLink()?.disabled).toBe(false);
  expect(button("Preview on Kiosk D").disabled).toBe(false);
});

it("marks Review as yours when a one-click copy stopped at the preview", async () => {
  await mount();
  await click("Copy to Kiosk D");
  await click("Copy to Kiosk D");
  expect(stepState()).toEqual(["Where:done", "Review:done", "Copy:done", "Done:current"]);
  expect(hasStep("what")).toBe(false);
});

it("offers no Change while coordinator context transfers", async () => {
  state.handlers.prepare = () => new Promise(() => {});
  statuses = [
    copyStatus("previewed", { mode: "copy-and-move" }),
    copyStatus("applied", {
      mode: "copy-and-move",
      projectId: "00000000-0000-4000-8000-000000000002",
    }),
  ];
  await mount(MOVE);
  await click("Copy and move to Kiosk D");
  await click("Copy and move to Kiosk D");
  expect(stageNow()).toBe("moving");
  expect(stepState()).toEqual([
    "Where:done",
    "Review:done",
    "Copy:done",
    "Transfer:current",
    "Done:next",
  ]);
  expect(changeLink()).toBeNull();
  expect(document.querySelectorAll('[data-slot="copy-actions"] button')).toHaveLength(0);
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
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("failed");
  expect(step("copy").getAttribute("data-state")).toBe("current");
  expect(step("copy").getAttribute("data-tone")).toBe("failed");
  // The state is read out with the label, not by color alone.
  expect(step("copy").textContent).toBe("Copy, stopped");
  expect(step("where").hasAttribute("data-tone")).toBe(false);
  expect(step("done").hasAttribute("data-tone")).toBe(false);
});

it("says a refused start in plain words, marks Where stopped and lets the person retry", async () => {
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = () => {
    throw new Error(
      "The copy failed on this machine: Private folder resolves elsewhere: /Users/sam/.specwithcode/staging",
    );
  };
  await mount();
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("setup");
  const alert = document.querySelector('[role="alert"]')?.textContent ?? "";
  // Names the machine it happened on and what to do, without "staging" or "drive".
  expect(alert).toContain(
    "SpecWithCode's working folder on Kiosk D (/Users/sam/.specwithcode/staging) is behind a shortcut, so the copy can't start. Use a normal folder that isn't a shortcut or inside one, then try again.",
  );
  expect(alert).not.toContain("Private folder resolves elsewhere");
  expect(step("where").getAttribute("data-tone")).toBe("failed");
  expect(step("where").textContent).toBe("Where, stopped");
  // The label stays and trying again is allowed.
  expect(button("Copy to Kiosk D").disabled).toBe(false);
  state.handlers.copyOffer = offer;
  await click("Copy to Kiosk D");
  expect(stageNow()).not.toBe("setup");
  expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("pins the machine it picked: one that connects later never retargets the button or the copy", async () => {
  await mount({ kioskDUnavailable: "Connecting…", deskBAvailable: true });
  expect(button("Copy to Desk B").disabled).toBe(false);
  // Kiosk D, listed first, finishes connecting: the label under the cursor stays Desk B.
  await mount({ deskBAvailable: true });
  expect(button("Copy to Desk B").disabled).toBe(false);
  await click("Copy to Desk B");
  // Desk B drops to reconnecting mid-copy while Kiosk D is ready: everything still goes to Desk B.
  await mount({});
  await settle();
  const touched = state.calls.map(
    ([, call]) => call as { environmentId?: string; input?: Record<string, unknown> },
  );
  expect(touched.some((call) => call?.environmentId === "deskB")).toBe(true);
  expect(touched.some((call) => call?.environmentId === "kioskD")).toBe(false);
  expect(touched.some((call) => call?.input?.["destinationEnvironmentId"] === "kioskD")).toBe(
    false,
  );
});

it("waits visibly for a machine, then picks the first that becomes ready", async () => {
  await mount({ kioskDUnavailable: "Connecting…" });
  // One filled primary, off, with what it waits for said beside it.
  expect(button("Copy").disabled).toBe(true);
  expect(document.querySelector('[data-slot="copy-setup-hint"]')?.textContent).toBe(
    "Choose a machine above.",
  );
  // No folder to ask about before there is a machine to put it on.
  expect(document.querySelector('input[aria-label^="Folder on"]')).toBeNull();
  await mount({});
  expect(button("Copy to Kiosk D").disabled).toBe(false);
  expect(folderInput().value).not.toBe("");
});

it("puts Stop copy first in the dialog footer as a bordered button while choosing", async () => {
  await mount({ dialog: true });
  await chooseFirst();
  await click("Copy to Kiosk D");
  const stop = button("Stop copy");
  expect(stop.hasAttribute("data-leading")).toBe(true);
  expect(stop.closest('[data-slot="dialog-footer"]')).not.toBeNull();
  expect(() => button("Back")).toThrow();
});

it("offers no Back anywhere", async () => {
  await mount();
  expect(() => button("Back")).toThrow();
  await chooseFirst();
  await click("Copy to Kiosk D");
  expect(() => button("Back")).toThrow();
});

it("cancels the copy from Review's Change setup, and opens the form with the same choices", async () => {
  await mount(MOVE);
  await chooseFirst();
  await click("Copy and move to Kiosk D");
  await click("Preview on Kiosk D");
  expect(stageNow()).toBe("preview");
  // Review's footer holds the way back; Your choices has no second one.
  expect(changeLink()).toBeNull();
  const change = button("Change setup");
  expect(change.hasAttribute("data-leading")).toBe(true);
  expect(change.getAttribute("aria-description")).toBe("Stops this copy and goes back");
  await click("Change setup");
  expect(names()).toContain("copyCancel");
  expect(names()).toContain("copySourceCancel");
  expect(names()).toContain("copyRelease");
  expect(pointerNow()).toBeNull();
  expect(stageNow()).toBe("setup");
  expect(document.querySelector('[data-slot="copy-cancelled"]')?.textContent).toBe(
    "Copy cancelled. Nothing on Kiosk D changed.",
  );
  expect(folderInput().disabled).toBe(false);
  expect(folderInput().value).toBe("/home/sam/Projects/project");
  expect(button("Copy and move to Kiosk D").disabled).toBe(false);
  // Closing right after keeps those choices for the next open.
  expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toMatchObject({
    machine: "kioskD",
    folder: "/home/sam/Projects/project",
    mode: "copy-and-move",
    chooseFirst: true,
  });
});

it("offers no Change once the copy is done, and Sync again… leads to the form", async () => {
  measuredWithoutSecrets();
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  await mount();
  await click("Copy to Kiosk D");
  expect(stepState().at(-1)).toBe("Done:current");
  expect(changeLink()).toBeNull();
  await openMore();
  // A finished copy offers the form as a visible second choice, never as the main button.
  expect(moreItems()).toEqual(["Run the same sync again"]);
  expect(() => button("Copy to Kiosk D")).toThrow();
  expect(button("Sync again…").getAttribute("data-variant")).not.toBe("default");
  const calls = state.calls.length;
  await click("Sync again…");
  expect(stageNow()).toBe("setup");
  expect(pointerNow()).toBeNull();
  expect(folderInput().value).toBe("/Users/me/Projects/project");
  expect(button("Copy to Kiosk D").disabled).toBe(false);
  // Nothing was measured or cancelled.
  expect(names().slice(calls)).toEqual([]);
});

it("offers no Change on a copy that failed once it reached Apply", async () => {
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
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("failed");
  // A partly applied copy is never dropped: Retry comes first.
  expect(changeLink()).toBeNull();
  expect(() => button("Stop copy")).toThrow();
  expect(button("Retry").disabled).toBe(false);
});

it("offers Change on a copy that failed before Apply", async () => {
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
  await click("Copy to Kiosk D");
  await click("Change (stops this copy)");
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
      environmentId: "kioskD",
      mode: "copy-and-move",
      targetFolder: "/Users/me/Projects/project",
      projectId: applied.projectId,
      selection: applied.selection,
    }),
  );
  await mount();
  await settle();
  expect(stepState()).toContain("Transfer:current");
  expect(button("Continue the coordinator on Kiosk D").disabled).toBe(false);
  await openMore();
  expect(isDisabled(button("Add to another machine"))).toBe(true);
  // Copy again releases the source too, so it is locked the same way.
  expect(isDisabled(button("Run the same sync again"))).toBe(true);
});

// Reopening: the dialog checks the copy first, then brings back the step that was on screen.
const LAST_KEY = "specwithcode:folder-copy-last:laptopE:source";
const DRAFT_KEY = "specwithcode:folder-copy-draft:laptopE:source";
const reopen = async (overrides: FixtureOptions = {}) => {
  await act(async () => root.unmount());
  state.calls = [];
  root = createRoot(container);
  await mount(overrides);
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
  await click("Copy to Kiosk D");
  await click("Preview on Kiosk D");
  expect(stageNow()).toBe("preview");
};

it("shows Checking while a reopened copy waits for the destination, with no form or buttons", async () => {
  await toPreview();
  expect(pointerNow()).toMatchObject({ seen: "review" });
  let answer: (value: unknown) => void = () => {};
  state.handlers.copyStatus = () => new Promise((resolve) => (answer = resolve));
  await reopen();
  await settle();
  expect(checkingText()).toBe("Checking the copy to /home/sam/Projects/project on Kiosk D…");
  expect(folderInput()).toBeNull();
  expect(document.querySelectorAll('[data-slot="copy-actions"] button')).toHaveLength(0);
  // The line holds the step last seen while checking.
  expect(stepState()).toEqual([
    "Where:done",
    "What:done",
    "Review:current",
    "Copy:next",
    "Done:next",
  ]);

  await act(async () => answer(copyStatus("previewed")));
  await settle();
  expect(checkingText()).toBeNull();
  expect(stageNow()).toBe("preview");
  expect(noteText()).toBeNull();
  expect(button("Copy to Kiosk D").disabled).toBe(false);
});

it("says a copy finished while closed, then keeps it as the last copy with View and Undo", async () => {
  await toPreview();
  // The destination answers with the folder the copy went to.
  state.handlers.copyStatus = () =>
    copyStatus("applied", { targetFolder: "/home/sam/Projects/project" });
  await reopen();
  await settle();
  expect(stageNow()).toBe("done");
  expect(noteText()).toBe("This copy finished while the window was closed.");
  expect(state.link).toHaveBeenCalledOnce();
  expect(pointerNow()).toMatchObject({ seen: "done", doneSeen: true, linked: true });

  // Done was seen: the next plain reopen still shows the finished copy, not a form that
  // reads as "copy it again".
  await reopen();
  await settle();
  expect(stageNow()).toBe("done");
  expect(noteText()).toBeNull();
  expect(folderInput()).toBeNull();
  expect(() => button("Copy to Kiosk D")).toThrow();
  expect(button("Open on Kiosk D")).toBeTruthy();
  expect(button("Undo…")).toBeTruthy();
  expect(state.link).toHaveBeenCalledOnce();
  // The form is one click away, and keeps this copy as the last copy.
  await click("Sync again…");
  expect(stageNow()).toBe("setup");
  expect(pointerNow()).toBeNull();
  expect(document.querySelector('[data-slot="copy-last"]')?.textContent).toBe(
    "The last copy to /home/sam/Projects/project on Kiosk D finished. View it to undo it.View",
  );
  // The form starts from the last copy's choices.
  expect(folderInput().value).toBe("/home/sam/Projects/project");
  expect(button("Copy to Kiosk D").disabled).toBe(false);

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
  state.link = vi.fn(async () => ({
    status: "review",
    reason: "Notes differ.",
    // What a machine said is shown as it said it.
    words: { text: "Notes differ.", verbatim: true },
  }));
  await mount();
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("done");
  expect(pageText()).toContain("Not linked yet. Notes differ.");
  // Kept for the machine menu, which says it after this dialog is closed.
  expect(linkRefusalsForTest()).toEqual([{ text: "Notes differ.", verbatim: true }]);
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
  await click("Copy to Kiosk D");
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
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("failed");
  expect(document.querySelector('[data-slot="copy-next"]')?.textContent).toBe(
    "Retry starts the copy again: it measures again, then you choose what to copy and preview it. Nothing on Kiosk D changed, so Stop copy leaves it as it was.",
  );
  statuses = [copyStatus("previewed")];
  await click("Retry");
  expect(stageNow()).toBe("select");
  expect(noteText()).toBe("Retry started this copy again from the beginning.");
  await click("Preview on Kiosk D");
  expect(stageNow()).toBe("preview");
  expect(noteText()).toBeNull();
});

it("keeps the step last seen when the destination does not answer, with Check again", async () => {
  await toPreview();
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("Kiosk D is offline."), {
      _tag: "FolderCopyError",
      code: "unreachable",
    });
  };
  await reopen();
  await settle();
  expect(stepState()).toContain("Review:current");
  expect(checkingText()).toBe(
    "A copy to /home/sam/Projects/project on Kiosk D is unfinished. Check it again once Kiosk D is reachable.",
  );
  expect(folderInput()).toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe("Kiosk D is offline.");
  expect(pointerNow()).toMatchObject({ seen: "review" });

  state.handlers.copyStatus = () => copyStatus("previewed");
  await click("Check the copy again");
  expect(checkingText()).toBeNull();
  expect(stageNow()).toBe("preview");
  expect(button("Copy to Kiosk D").disabled).toBe(false);
});

it("shows an old pointer's live step as before, and starts remembering it", async () => {
  measured();
  localStorage.setItem(
    KEY,
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "kioskD",
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
  expect(pointerNow()).toMatchObject({ seen: "review" });
});

it("remembers the setup form while no copy has started", async () => {
  await mount(MOVE);
  await chooseFirst();
  await editFolder("/home/sam/Elsewhere/project");
  expect(JSON.parse(localStorage.getItem(DRAFT_KEY)!)).toEqual({
    machine: "kioskD",
    folder: "/home/sam/Elsewhere/project",
    mode: "copy-and-move",
    chooseFirst: true,
    secrets: { included: true, out: [] },
  });
  // The draft keeps the folder and the choices; the move comes from how the dialog opened.
  await reopen(MOVE);
  await settle();
  expect(folderInput().value).toBe("/home/sam/Elsewhere/project");
  await click("Copy and move to Kiosk D");
  // The copy's pointer holds the choices from here.
  expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  expect(pointerNow()).toMatchObject({ targetFolder: "/home/sam/Elsewhere/project" });
});

it("keeps a finished copy as the last copy when a new one starts from Done", async () => {
  measuredWithoutSecrets();
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  await mount();
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("done");
  await click("Sync again…");
  expect(pointerNow()).toBeNull();
  expect(JSON.parse(localStorage.getItem(LAST_KEY)!)).toMatchObject({
    targetFolder: "/home/sam/Projects/project",
    auto: true,
  });
  expect(document.querySelector('[data-slot="copy-last"]')).not.toBeNull();
  expect(button("Copy to Kiosk D").disabled).toBe(false);
});

it("keeps Review as yours after a reopen when the plan was shown", async () => {
  measured();
  await mount();
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("preview");
  expect(pointerNow()).toMatchObject({ planShown: true });
  // Approved, then closed: the reopen never shows the preview again.
  state.handlers.copyStatus = () => copyStatus("applied");
  await reopen();
  await settle();
  expect(stageNow()).toBe("done");
  expect(hasStep("what")).toBe(false);
  expect(step("review").getAttribute("data-state")).toBe("done");
});

it("keeps the move and machine the dialog was opened with over the last copy-only copy", async () => {
  const last = {
    operationId: "last",
    environmentId: "kioskD",
    mode: "copy-only",
    targetFolder: "/home/sam/last",
    projectId: "copied",
    selection: ["tracked"],
    auto: true,
    finishedAt: "2026-10-19T20:00:00.000Z",
  };
  localStorage.setItem(LAST_KEY, JSON.stringify(last));
  // Opened plainly, the last copy shows as done; the form starts from it one click later.
  state.handlers.copyStatus = () => copyStatus("applied", { targetFolder: "/home/sam/last" });
  await mount();
  await settle();
  expect(stageNow()).toBe("done");
  await click("Sync again…");
  expect(button("Copy to Kiosk D").disabled).toBe(false);
  expect(folderInput().value).toBe("/home/sam/last");
  await act(async () => root.unmount());
  root = createRoot(container);
  localStorage.setItem(LAST_KEY, JSON.stringify(last));
  // "Move coordinator to Desk B": a move to Desk B, whatever the last copy was.
  await mount({
    deskBAvailable: true,
    defaultMode: "copy-and-move",
    preferredMachine: "deskB",
    machineRequested: true,
  });
  expect(button("Copy and move to Desk B").disabled).toBe(false);
  expect(() => button("Copy to Kiosk D")).toThrow();
  await act(async () => root.unmount());
  root = createRoot(container);
  // "Move project" with only a remembered machine: still a move; the draft may pick the machine.
  await mount({ deskBAvailable: true, defaultMode: "copy-and-move", preferredMachine: "deskB" });
  expect(button("Copy and move to Kiosk D").disabled).toBe(false);
});

it("lets the last copy go back to being the last copy when its destination is offline", async () => {
  measuredWithoutSecrets();
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  await mount();
  await click("Copy to Kiosk D");
  await click("Sync again…");
  expect(localStorage.getItem(LAST_KEY)).not.toBeNull();
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("Kiosk D is offline."), {
      _tag: "FolderCopyError",
      code: "unreachable",
    });
  };
  await click("View");
  expect(checkingText()).toBe(
    "The copy to /home/sam/Projects/project on Kiosk D finished. Kiosk D is not reachable now. Check again to view or undo it.",
  );
  expect(pointerNow()).toMatchObject({ reopened: true });
  await click("Add to another machine");
  expect(checkingText()).toBeNull();
  expect(stageNow()).toBe("setup");
  expect(pointerNow()).toBeNull();
  expect(JSON.parse(localStorage.getItem(LAST_KEY)!)).not.toHaveProperty("reopened");
  expect(document.querySelector('[data-slot="copy-last"]')).not.toBeNull();
  expect(button("Copy to Kiosk D").disabled).toBe(false);
});

it("shows a finished copy as finished on a plain reopen while its machine is offline", async () => {
  measuredWithoutSecrets();
  const rows = [newRow(".")];
  statuses = [copyStatus("previewed", { rows }), copyStatus("applied", { rows })];
  await mount();
  await click("Copy to Kiosk D");
  expect(pointerNow()).toMatchObject({ doneSeen: true });
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("Kiosk D is offline."), {
      _tag: "FolderCopyError",
      code: "unreachable",
    });
  };
  await reopen();
  await settle();
  expect(checkingText()).toBe(
    "The copy to /home/sam/Projects/project on Kiosk D finished. Kiosk D is not reachable now. Check again to view or undo it.",
  );
  expect(() => button("Copy to Kiosk D")).toThrow();
  // It never traps the person: a new copy is still one click away, and this one is kept.
  await click("Add to another machine");
  expect(stageNow()).toBe("setup");
  expect(pointerNow()).toBeNull();
  expect(localStorage.getItem(LAST_KEY)).not.toBeNull();
});

it("offers only Check again for an unfinished copy whose destination is offline", async () => {
  await toPreview();
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("Kiosk D is offline."), {
      _tag: "FolderCopyError",
      code: "unreachable",
    });
  };
  await reopen();
  await settle();
  expect(checkingText()).not.toBeNull();
  expect(() => button("Add to another machine")).toThrow();
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
  expect(button("Add to another machine")).toBeTruthy();
});

it("refreshes a resumed saved scan without cancelling, reoffering or changing stored choices", async () => {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      operationId: "saved",
      environmentId: "kioskD",
      mode: "copy-only",
      targetFolder: "/home/sam/project",
      projectId: null,
      selection: ["tracked"],
      planShown: true,
    }),
  );
  state.handlers.copySourceStatus = ({ input }: any) => ({
    state: "ready",
    summary: noSecrets,
    scanCompletedAt: 1793061000000,
    ...(input.refresh ? { freshness: { checkedAt: 1793062000000, current: true } } : {}),
  });
  statuses = [copyStatus("previewed", { rows: [newRow(".")] })];
  await mount();
  await settle();
  const saved = pointerNow();
  const calls = state.calls.length;
  await click("Check for changes");
  expect(pageText()).toContain("Nothing changed since then, so your choices stay.");
  expect(pointerNow()).toEqual(saved);
  expect(state.calls.slice(calls).map(([name]) => name)).toEqual(["copySourceStatus"]);
  expect(state.calls.at(-1)?.[1]).toMatchObject({ input: { operationId: "saved", refresh: true } });
});

it("replaces saved worktree notices with current counts after refreshing", async () => {
  const old =
    "repos/old: 36 worktree(s) outside this folder are not copied: removed-a, removed-b. Copy those folders separately.";
  const fresh =
    "repos/current: 22 worktree(s) outside this folder are not copied: current-a, current-b and 20 more. Their committed branches come along.";
  statuses = [
    copyStatus("previewed", {
      rows: [newRow(".")],
      warnings: [old, "Destination contains local edits."],
    }),
  ];
  await toPreview();
  expect(pageText()).toContain("36 worktrees outside the folder.");
  const saved = pointerNow();
  state.handlers.copySourceStatus = () => ({
    state: "ready",
    summary: noSecrets,
    freshness: {
      checkedAt: Date.now(),
      current: false,
      summary: { ...noSecrets, warnings: [fresh] },
    },
  });
  await click("Check for changes");
  expect(pageText()).toContain("22 worktrees outside the folder.");
  expect(pageText()).toContain("20 more names not included in this scan");
  expect(pageText()).not.toContain("removed-a");
  expect(pageText()).toContain("Destination contains local edits.");
  expect(pointerNow()).toEqual(saved);
  // A found change leaves one way on: measure and compare again, not a second check.
  expect(pageText()).not.toContain("Check for changes");
  expect(button("Compare again")).not.toBeNull();
});

it("offers Measure and compare again on What once the source changed, with Preview off", async () => {
  measuredWithoutSecrets();
  measured();
  await mount();
  await chooseFirst();
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("select");
  state.handlers.copySourceStatus = () => ({
    state: "ready",
    summary: noSecrets,
    freshness: { checkedAt: Date.now(), current: false },
  });
  await click("Check for changes");
  // Preview is off while the source changed, so What must keep a way forward.
  expect(button("Preview on Kiosk D").disabled).toBe(true);
  expect(pageText()).not.toContain("Check for changes");
  const compare = document.querySelectorAll('[data-slot="copy-scan-freshness"] button');
  expect([...compare].map((node) => node.textContent)).toEqual(["Compare again"]);
});

it("unlocks a stalled read-only refresh without changing choices or accepting a late reply", async () => {
  await toPreview();
  const saved = pointerNow();
  const calls = state.calls.length;
  let finish!: (value: unknown) => void;
  state.handlers.copySourceStatus = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  vi.useFakeTimers();
  try {
    await act(async () => button("Check for changes").click());
    expect(isDisabled(button("Check for changes"))).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(pageText()).toContain("Checking this scan took too long.");
    expect(isDisabled(button("Check for changes"))).toBe(false);
    expect(pointerNow()).toEqual(saved);
    await act(async () =>
      finish({
        state: "ready",
        summary: noSecrets,
        freshness: { checkedAt: Date.now(), current: true },
      }),
    );
    expect(pageText()).not.toContain("Nothing changed since then, so your choices stay.");
    expect(pointerNow()).toEqual(saved);
    expect(state.calls.slice(calls).map(([name]) => name)).toEqual(["copySourceStatus"]);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["typed", "legacy"])(
  "recovers a %s stale refusal across reopening without another approval",
  async (protocol) => {
    await toPreview();
    const old = pointerNow();
    state.handlers.copyStatus = () => copyStatus("previewed", { rows: [newRow(".")] });
    state.handlers.copyApprove = () => {
      throw Object.assign(new Error("Source changed"), {
        _tag: "FolderCopyError",
        code: "refused",
        ...(protocol === "typed"
          ? { recovery: "compare_again" }
          : {
              detail:
                "The source changed or this saved scan has no freshness evidence. Refresh the scan and review a new comparison before copying.",
            }),
      });
    };
    await click("Copy to Kiosk D");
    expect(stageNow()).toBe("preview");
    expect(pointerNow()).toMatchObject({
      operationId: old.operationId,
      needsComparison: true,
      planShown: true,
    });
    expect(button("Copy to Kiosk D").disabled).toBe(true);
    const footer = document.querySelector('[data-slot="copy-actions"]');
    expect(footer?.textContent).toContain("Compare again");
    expect(names().filter((name) => name === "copyApprove")).toHaveLength(1);
    expect(names()).not.toContain("copyCancel");
    await reopen();
    await settle();
    expect(stageNow()).toBe("preview");
    expect(button("Copy to Kiosk D").disabled).toBe(true);
    expect(names()).not.toContain("copyApprove");
    const before = state.calls.length;
    await click("Compare again");
    expect(stageNow()).toBe("select");
    expect(pointerNow().operationId).not.toBe(old.operationId);
    expect(pointerNow()).not.toHaveProperty("needsComparison");
    expect(pointerNow()).not.toHaveProperty("replaceAll");
    expect(pointerNow()).toMatchObject({
      environmentId: old.environmentId,
      targetFolder: old.targetFolder,
      selection: old.selection,
    });
    expect(state.calls.slice(before).map(([name]) => name)).not.toContain("copyApprove");
    await click("Preview on Kiosk D");
    expect(stageNow()).toBe("preview");
    expect(button("Copy to Kiosk D").disabled).toBe(false);
  },
);

it("requires approval of captured files and keeps later live changes separate from that copy", async () => {
  measuredWithoutSecrets();
  const capturedAt = 1793061000000;
  state.handlers.copySourceStatus = ({ input }: any) => ({
    state: "ready",
    summary: noSecrets,
    capturedAt,
    ...(input.refresh
      ? {
          freshness: {
            checkedAt: capturedAt + 1000,
            current: false,
            summary: { ...noSecrets, warnings: ["New source-only measurement notice."] },
          },
        }
      : {}),
  });
  statuses = [copyStatus("previewed", { capturedAt, rows: [newRow(".")] }), copyStatus("applied")];
  await mount();
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("preview");
  expect(state.calls.filter(([name]) => name === "copyApprove")).toHaveLength(0);
  expect(pageText()).toContain("This copy uses files captured");
  const saved = pointerNow();
  await click("Check for changes");
  expect(pageText()).toContain("You can still copy the captured files");
  expect(pageText()).toContain(
    "measurements and notices show the current source, not new copy contents",
  );
  expect(pageText()).toContain("New source-only measurement notice.");
  expect(pointerNow()).toEqual(saved);
  expect(isDisabled(button("Copy to Kiosk D"))).toBe(false);
  expect(state.calls.filter(([name]) => name === "copyApprove")).toHaveLength(0);
  await click("Copy to Kiosk D");
  expect(state.calls.filter(([name]) => name === "copyApprove")).toHaveLength(1);
  expect(stageNow()).toBe("done");
});

it("does not auto-approve a captured destination preview when source diagnostics are unavailable", async () => {
  measuredWithoutSecrets();
  state.handlers.copySourceStatus = () => {
    throw new Error("source diagnostics unavailable");
  };
  statuses = [copyStatus("previewed", { capturedAt: 1793061000000, rows: [newRow(".")] })];
  await mount();
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("preview");
  expect(pageText()).toContain("This copy uses files captured");
  expect(state.calls.filter(([name]) => name === "copyApprove")).toHaveLength(0);
});

it("keeps manual review with an older destination and unavailable source diagnostics", async () => {
  measuredWithoutSecrets();
  state.handlers.copySourceStatus = () => {
    throw new Error("source diagnostics unavailable");
  };
  statuses = [copyStatus("previewed", { rows: [newRow(".")] })];
  await mount();
  await click("Copy to Kiosk D");
  expect(stageNow()).toBe("preview");
  expect(state.calls.filter(([name]) => name === "copyApprove")).toHaveLength(0);
  expect(button("Copy to Kiosk D").disabled).toBe(false);
});
