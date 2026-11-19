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
  expect(text).toContain("Nothing running here can go.");
});

it("says when the project has nothing running that can move", async () => {
  await act(async () => root.render(<HandOffMachineDialogView {...props({ threads: [] })} />));
  expect(document.body.textContent).toContain("Nothing running in atlas on M4 can go.");
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
