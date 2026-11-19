// @vitest-environment jsdom
import type { EnvironmentId, HandoffPreflightResult, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  handOffMachinePrimaryLabel,
  handOffMachineScope,
  handOffMachineTitle,
  HandOffMachineDialogView,
  type HandOffMachineDialogViewProps,
} from "./HandOffMachineDialog";

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

const MINIS = "env-minis" as EnvironmentId;
const ready = "t-ready" as ThreadId;
const blocked = "t-blocked" as ThreadId;

const preflight = (threadId: ThreadId, patch: Partial<HandoffPreflightResult> = {}) =>
  ({
    threadId,
    title: threadId,
    ok: true,
    failures: [],
    resume: true,
    runEnding: "active",
    ...patch,
  }) as HandoffPreflightResult;

const props = (
  patch: Partial<HandOffMachineDialogViewProps> = {},
): HandOffMachineDialogViewProps => ({
  machineName: "M4",
  projectName: "atlas",
  destinations: [{ environmentId: MINIS, label: "Minis", state: "reachable" }],
  destinationId: MINIS,
  onDestination: vi.fn(),
  threads: [
    { threadId: ready, title: "Fix the build" },
    { threadId: blocked, title: "Write docs" },
  ],
  selected: new Set([ready, blocked]),
  onToggle: vi.fn(),
  checking: false,
  preflight: new Map([
    [ready, preflight(ready)],
    [
      blocked,
      preflight(blocked, {
        ok: false,
        failures: [{ check: "ignored-files", message: "Minis: no .env.local" }],
      }),
    ],
  ]),
  preflightError: null,
  submitting: false,
  error: null,
  run: null,
  destinationName: "Minis",
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  onOpenThread: vi.fn(),
  ...patch,
});

const buttons = () => [...document.querySelectorAll("button")];
const button = (text: string) => buttons().find((item) => item.textContent === text);

it("hands off one project's threads with a check result per thread", async () => {
  const view = props();
  await act(async () => root.render(<HandOffMachineDialogView {...view} />));
  const text = document.body.textContent ?? "";
  expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe(
    "Hand off work from M4",
  );
  expect(text).toContain(
    "Tick what goes. It continues on the machine you pick. Anything that cannot go stays here, untouched, with its reason.",
  );
  expect(document.querySelector('[data-slot="hand-off-scope"]')?.textContent).toBe("Scope: atlas");
  // Coordinator conversations and routines are not rows of a hand off.
  expect(text).not.toMatch(/coordinator|routine/i);
  expect(text).toContain("Running (2)");
  expect(text).toContain("The current turn keeps running there.");
  expect(text).toContain("Minis can't take it yet:");
  // The destination's failure text, verbatim and tagged with its check.
  expect(document.querySelector('[data-check="ignored-files"]')?.textContent).toBe(
    "Minis: no .env.local",
  );
  expect(document.querySelector(`[data-thread-status="ready"]`)?.textContent).toContain("Goes");
  expect(document.querySelector(`[data-thread-status="failed"]`)).not.toBeNull();
  // Machines are radio rows.
  expect(document.querySelector('[data-slot="machine-option"]')?.textContent).toContain("Minis");
  // Only the thread that passed its checks moves.
  const submit = button("Hand off to Minis");
  expect(submit).toBeDefined();
  await act(async () => submit!.click());
  expect(view.onSubmit).toHaveBeenCalledTimes(1);
});

it("keeps the whole-machine wording without a project", async () => {
  await act(async () =>
    root.render(<HandOffMachineDialogView {...props({ projectName: null, threads: [] })} />),
  );
  const text = document.body.textContent ?? "";
  expect(text).toContain("Hand off work from M4");
  expect(text).toContain("Scope: every project on M4");
  expect(text).not.toContain("coordinator");
  expect(text).toContain("Nothing here can go.");
});

it("says when nothing in the project can go", async () => {
  await act(async () => root.render(<HandOffMachineDialogView {...props({ threads: [] })} />));
  expect(document.body.textContent).toContain("Nothing in atlas on M4 can go.");
});

it("lists idle work under Waiting for your next message and what cannot go under Stays (AC-17)", async () => {
  const idle = "t-idle" as ThreadId;
  const question = "t-question" as ThreadId;
  const view = props({
    threads: [
      { threadId: ready, title: "Fix the build", group: "running" },
      { threadId: idle, title: "Plan the release", group: "waiting" },
      { threadId: question, title: "Pick a name", group: "stays", reason: "Answer it first" },
    ],
    selected: new Set([ready, idle]),
    preflight: new Map([
      [ready, preflight(ready)],
      [idle, preflight(idle, { resume: false, runEnding: "completed" })],
    ]),
  });
  await act(async () => root.render(<HandOffMachineDialogView {...view} />));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Running (1)");
  expect(text).toContain("Waiting for your next message (1)");
  expect(text).toContain("Stays (1)");
  const waiting = document.querySelector('[aria-label="Waiting for your next message"]');
  expect(waiting?.textContent).toContain("Plan the release");
  // An idle thread arrives Ready: it waits there and starts no turn.
  expect(waiting?.textContent).toContain("It will wait there for your next message.");
  expect(waiting?.querySelector('[data-thread-status="ready"]')).not.toBeNull();
  const stays = document.querySelector('[aria-label="Stays here"]');
  expect(stays?.textContent).toContain("Pick a name");
  expect(stays?.textContent).toContain("Answer it first");
  // A row that stays cannot be ticked.
  expect(stays?.querySelector('[role="checkbox"]')).toBeNull();
  expect(stays?.querySelector("[data-thread-status]")?.getAttribute("data-thread-status")).toBe(
    "stays",
  );
  await act(async () => button("Hand off to Minis")!.click());
  expect(view.onSubmit).toHaveBeenCalledTimes(1);
});

it("says nothing can go when every row stays", async () => {
  const question = "t-question" as ThreadId;
  await act(async () =>
    root.render(
      <HandOffMachineDialogView
        {...props({
          threads: [
            { threadId: question, title: "Pick a name", group: "stays", reason: "Answer it first" },
          ],
          selected: new Set(),
          preflight: new Map(),
        })}
      />,
    ),
  );
  expect(document.body.textContent).toContain("Nothing in atlas on M4 can go.");
  expect(document.body.textContent).toContain("Stays (1)");
  expect(button("Nothing can go")?.disabled).toBe(true);
});

it("disables the primary as 'Nothing can go' when no selected thread passed", async () => {
  const view = props({ selected: new Set([blocked]) });
  await act(async () => root.render(<HandOffMachineDialogView {...view} />));
  const submit = button("Nothing can go");
  expect(submit?.disabled).toBe(true);
  await act(async () => submit!.closest("form")!.requestSubmit());
  expect(view.onSubmit).not.toHaveBeenCalled();
});

it("counts plural threads in the primary", async () => {
  await act(async () =>
    root.render(
      <HandOffMachineDialogView
        {...props({
          preflight: new Map([
            [ready, preflight(ready)],
            [blocked, preflight(blocked, { resume: false })],
          ]),
        })}
      />,
    ),
  );
  expect(button("Hand off to Minis")?.disabled).toBe(false);
  expect(document.body.textContent).toContain("It will wait there for your next message.");
});

it("shows Checking… per row and drops earlier results while a check runs", async () => {
  await act(async () => root.render(<HandOffMachineDialogView {...props({ checking: true })} />));
  const text = document.body.textContent ?? "";
  expect(text).not.toContain("can't take it yet");
  expect(document.querySelectorAll('[data-thread-status="checking"]')).toHaveLength(2);
  expect(button("Checking…")?.disabled).toBe(true);
  expect(button("Try again")).toBeUndefined();
});

it("offers to try again while a selected thread fails a check", async () => {
  const view = props({ onRecheck: vi.fn() });
  await act(async () => root.render(<HandOffMachineDialogView {...view} />));
  await act(async () => button("Try again")!.click());
  expect(view.onRecheck).toHaveBeenCalledTimes(1);

  await act(async () =>
    root.render(
      <HandOffMachineDialogView {...props({ onRecheck: vi.fn(), selected: new Set([ready]) })} />,
    ),
  );
  expect(button("Try again")).toBeUndefined();

  // Without a destination there is nothing to try again against.
  await act(async () =>
    root.render(
      <HandOffMachineDialogView {...props({ onRecheck: vi.fn(), destinationId: null })} />,
    ),
  );
  expect(button("Try again")).toBeUndefined();
});

it("names the destination when it can't be reached, and offers to try again", async () => {
  const view = props({ onRecheck: vi.fn(), preflight: new Map(), preflightError: "timed out" });
  await act(async () => root.render(<HandOffMachineDialogView {...view} />));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn't reach Minis: timed out",
  );
  expect(button("Try again")).toBeDefined();
});

it("shows offline machines disabled with a reason, and says when none is online", async () => {
  await act(async () =>
    root.render(
      <HandOffMachineDialogView
        {...props({
          destinations: [{ environmentId: MINIS, label: "Minis", state: "offline" }],
          destinationId: null,
        })}
      />,
    ),
  );
  const row = document.querySelector('[data-slot="machine-option"]');
  expect(row?.getAttribute("data-tone")).toBe("off");
  expect(row?.textContent).toContain("Offline");
  expect(document.body.textContent).toContain(
    "No other machine is online. Pair one in Settings › Machines.",
  );
});

it("hides the close X and locks the form while moving", async () => {
  await act(async () => root.render(<HandOffMachineDialogView {...props({ submitting: true })} />));
  expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
  expect(button("Handing off…")?.disabled).toBe(true);
  expect(button("Cancel")?.disabled).toBe(true);
});

it("shows the progress view in place of the form, and can be closed while it runs", async () => {
  const view = props({ submitting: true, progress: <p data-testid="progress">2 of 4 finished</p> });
  await act(async () => root.render(<HandOffMachineDialogView {...view} />));
  expect(document.querySelector('[data-testid="progress"]')).not.toBeNull();
  expect(document.querySelector('[data-slot="machine-options"]')).toBeNull();
  // The machine finishes the hand off without this window.
  expect(document.body.textContent).toContain(
    "M4 finishes this hand off by itself. You can close this.",
  );
  expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
  await act(async () => button("Done")!.click());
  expect(view.onCancel).toHaveBeenCalledTimes(1);
});

it("shows Handed off / Stayed / Skipped results with Open on the destination and Done", async () => {
  const view = props({
    run: {
      destinationEnvironmentId: MINIS,
      destinationLabel: "Minis",
      results: [
        {
          threadId: ready,
          title: "Fix the build",
          outcome: "moved",
          continuedThreadId: "t-new",
          resumed: true,
        },
        {
          threadId: blocked,
          title: "Write docs",
          outcome: "stayed",
          detail: "Minis: no .env.local",
        },
      ],
    } as unknown as HandOffMachineDialogViewProps["run"],
  });
  await act(async () => root.render(<HandOffMachineDialogView {...view} />));
  expect(document.querySelector('[data-outcome="moved"]')?.textContent).toContain("Handed off");
  expect(document.querySelector('[data-outcome="stayed"]')?.textContent).toContain(
    "Minis: no .env.local",
  );
  await act(async () => button("Open on Minis")!.click());
  expect(view.onOpenThread).toHaveBeenCalledWith("t-new", MINIS);
  expect(buttons().some((item) => item.textContent === "Close")).toBe(false);
  await act(async () => button("Done")!.click());
  expect(view.onCancel).toHaveBeenCalledTimes(1);
});

it("words the primary for each state", () => {
  expect(handOffMachinePrimaryLabel({ submitting: false, checking: false, movable: 0 })).toBe(
    "Nothing can go",
  );
  expect(handOffMachinePrimaryLabel({ submitting: true, checking: false, movable: 3 })).toBe(
    "Handing off…",
  );
  expect(
    handOffMachinePrimaryLabel({
      submitting: false,
      checking: false,
      movable: 2,
      machine: "Minis",
    }),
  ).toBe("Hand off to Minis");
  expect(handOffMachineTitle("M4")).toBe("Hand off work from M4");
  expect(handOffMachineScope("M4", null)).toBe("Scope: every project on M4");
  expect(handOffMachineScope("M4", "atlas")).toBe("Scope: atlas");
});

it("keeps this request's error in view beside the progress of what was written", async () => {
  await act(async () =>
    root.render(
      <HandOffMachineDialogView
        {...props({
          progress: <p data-slot="hand-off-progress">progress</p>,
          error: "Minis: the request was refused",
        })}
      />,
    ),
  );
  expect(document.querySelector('[data-slot="hand-off-progress"]')).not.toBeNull();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Minis: the request was refused",
  );
});

it("says when more threads are ticked than one hand off takes", async () => {
  await act(async () => root.render(<HandOffMachineDialogView {...props({ overLimit: true })} />));
  expect(document.body.textContent).toContain(
    "Up to 100 threads go in one hand off. Hand off the rest after.",
  );
  await act(async () => root.render(<HandOffMachineDialogView {...props()} />));
  expect(document.body.textContent).not.toContain("Up to 100 threads");
});

it("shows the plan's groups and each machine's usage line (AC-17, AC-22)", async () => {
  const queued = "t-queued" as ThreadId;
  const unsaved = "t-unsaved" as ThreadId;
  const folder = "folder-work:project-atlas" as ThreadId;
  const view = props({
    destinations: [
      { environmentId: MINIS, label: "Minis", state: "reachable" },
      { environmentId: "env-desk" as EnvironmentId, label: "Desk", state: "reachable" },
    ],
    usage: new Map([
      [MINIS, ["Same Claude account as M4: adds no usage"]],
      ["env-desk" as EnvironmentId, ["Usage unknown"]],
    ]),
    threads: [
      {
        threadId: queued,
        title: "Ship it",
        group: "queued",
        canTick: false,
        reason: "Its queued messages do not travel in a hand off by hand yet.",
      },
      { threadId: unsaved, title: "Draft notes", group: "unsaved" },
      {
        threadId: folder,
        title: "atlas",
        group: "folder-work",
        kind: "folder-work",
        reason: "1 branch only on M4",
      },
      {
        threadId: blocked,
        title: "Fix the API",
        group: "stays",
        reason: "data/dump.bin is 12 MB, over the 10 MB limit for one file",
      },
    ],
    selected: new Set([folder]),
    preflight: new Map(),
  });
  await act(async () => root.render(<HandOffMachineDialogView {...view} />));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Queued (1)");
  expect(text).toContain("Not running with unsaved work (1)");
  expect(text).toContain("Project folder work (1)");
  expect(text).toContain("Stays (1)");
  expect(text).toContain("Same Claude account as M4: adds no usage");
  expect(text).toContain("Usage unknown");
  // A queued row is listed with why it cannot be ticked yet.
  const queue = document.querySelector('[aria-label="Queued"]');
  expect(queue?.textContent).toContain("Its queued messages do not travel");
  expect(queue?.querySelector('[role="checkbox"]')).toBeNull();
  expect(document.querySelector('[aria-label="Project folder work"]')?.textContent).toContain(
    "1 branch only on M4",
  );
  expect(document.querySelector('[aria-label="Stays here"]')?.textContent).toContain(
    "over the 10 MB limit",
  );
  // Folder work needs no thread check: ticked, it can go.
  await act(async () => button("Hand off to Minis")!.click());
  expect(view.onSubmit).toHaveBeenCalledTimes(1);
});
