// @vitest-environment jsdom
import type { EnvironmentId, HandoffPreflightResult, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  handOffPrimaryLabel,
  HandOffThreadDialogView,
  type HandOffThreadDialogViewProps,
} from "./HandOffThreadDialog";

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

const M4 = "env-m4" as EnvironmentId;
const MINIS = "env-minis" as EnvironmentId;
const M1 = "env-m1" as EnvironmentId;

const check = (patch: Partial<HandoffPreflightResult> = {}) =>
  ({
    threadId: "t-1" as ThreadId,
    title: "Fix the build",
    ok: true,
    failures: [],
    resume: true,
    runEnding: "active",
    ...patch,
  }) as HandoffPreflightResult;

const props = (
  patch: Partial<HandOffThreadDialogViewProps> = {},
): HandOffThreadDialogViewProps => ({
  title: "Fix the build",
  destinations: [
    { environmentId: M4, label: "M4", state: "this-machine" },
    { environmentId: MINIS, label: "Minis", state: "reachable" },
    { environmentId: M1, label: "M1", state: "offline", reason: "Offline" },
  ],
  destinationId: MINIS,
  onDestination: vi.fn(),
  modelSummary: "Claude Code · Opus 5.5",
  modelPicker: <button type="button">model-picker</button>,
  preflight: { state: "done", results: [check()] },
  onRecheck: vi.fn(),
  submitting: false,
  error: null,
  result: null,
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  onOpenContinuation: vi.fn(),
  ...patch,
});

const render = (view: HandOffThreadDialogViewProps) =>
  act(async () => root.render(<HandOffThreadDialogView {...view} />));
const text = () => document.body.textContent ?? "";
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((item) => item.textContent === label);

it("moves to a picked machine in one screen, with the model as a summary", async () => {
  const view = props();
  await render(view);
  expect(text()).toContain('Move "Fix the build"');
  expect(text()).toContain(
    "Its conversation and file changes go with it. This copy stops and stays here to read.",
  );
  // This machine is never a choice when moving; offline machines show, disabled, with a reason.
  const rows = [...document.querySelectorAll('[data-slot="machine-option"]')];
  expect(rows.map((row) => row.textContent)).toEqual(["Minis", "M1Offline"]);
  expect(text()).toContain("Model: Claude Code · Opus 5.5");
  expect(text()).not.toContain("model-picker");
  expect(text()).toContain("Ready. The current turn keeps running there.");
  expect(button("Try again")).toBeUndefined();
  const submit = button("Move to Minis")!;
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
  expect(view.onSubmit).toHaveBeenCalledTimes(1);
});

it("opens the model choice when the thread has no model, so it is not a dead end", async () => {
  await render(props({ modelSummary: null, preflight: { state: "idle" } }));
  expect(text()).toContain("model-picker");
  expect(text()).toContain("Choose a model to continue with.");
  expect(text()).toContain("Model on Minis");
  expect(button("Move to Minis")!.disabled).toBe(true);
});

it("shows the destination's failures verbatim and offers to try again", async () => {
  const view = props({
    preflight: {
      state: "done",
      results: [
        check({
          ok: false,
          failures: [{ check: "ignored-files", message: "Minis: no .env.local" }],
        }),
      ],
    },
  });
  await render(view);
  expect(text()).toContain("Minis can't take it yet:");
  expect(document.querySelector('[data-check="ignored-files"]')?.textContent).toBe(
    "Minis: no .env.local",
  );
  expect(button("Move to Minis")!.disabled).toBe(true);
  await act(async () => button("Try again")!.click());
  expect(view.onRecheck).toHaveBeenCalledTimes(1);
});

it("offers to try again when the check could not reach the machine", async () => {
  await render(props({ preflight: { state: "error", message: "Minis is not connected." } }));
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Couldn't reach Minis: Minis is not connected.",
  );
  expect(button("Try again")).toBeDefined();
});

it("says it is checking and waits", async () => {
  await render(props({ preflight: { state: "checking" } }));
  expect(text()).toContain("Checking Minis…");
  expect(button("Checking…")!.disabled).toBe(true);
});

it("hides the close button while moving", async () => {
  await render(props());
  expect(document.querySelector('[data-slot="dialog-close"]')).not.toBeNull();
  await render(props({ submitting: true }));
  expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
  expect(button("Moving…")!.disabled).toBe(true);
  expect(button("Cancel")!.disabled).toBe(true);
});

it("says so when no other machine is online", async () => {
  await render(
    props({
      destinations: [
        { environmentId: M4, label: "M4", state: "this-machine" },
        { environmentId: M1, label: "M1", state: "offline", reason: "Offline" },
      ],
      destinationId: null,
      preflight: { state: "idle" },
    }),
  );
  expect(text()).toContain("No other machine is online. Pair one in Settings › Connections.");
  expect(button("Move")!.disabled).toBe(true);
});

it("ends on one done screen that opens the thread on the other machine", async () => {
  const view = props({
    result: {
      machine: "Minis",
      value: { notice: "Not carried over: .env.local" } as never,
    },
  });
  await render(view);
  expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("Moved to Minis");
  expect(document.querySelector('[role="status"]')?.textContent).toContain(
    '"Fix the build" continues on Minis.',
  );
  expect(text()).toContain("Not carried over: .env.local");
  await act(async () => button("Open on Minis")!.click());
  expect(view.onOpenContinuation).toHaveBeenCalledTimes(1);
});

it("switches the model here without a machine choice", async () => {
  await render(
    props({
      mode: "switch-model",
      destinationId: M4,
      preflight: { state: "done", results: [check({ resume: false })] },
    }),
  );
  expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("Switch model");
  expect(text()).toContain('"Fix the build" keeps going here with the model you pick.');
  expect(document.querySelector('[data-slot="machine-option"]')).toBeNull();
  expect(text()).toContain("model-picker");
  expect(text()).not.toContain("stays here to read");
  expect(text()).toContain("Ready. It will wait for your next message.");
  expect(text()).not.toContain("there");
  expect(button("Switch and continue")!.disabled).toBe(false);
});

it("labels the main button for each state", () => {
  const base = { mode: "move", submitting: false, checking: false, machine: "Minis" } as const;
  expect(handOffPrimaryLabel(base)).toBe("Move to Minis");
  expect(handOffPrimaryLabel({ ...base, checking: true })).toBe("Checking…");
  expect(handOffPrimaryLabel({ ...base, submitting: true })).toBe("Moving…");
  expect(handOffPrimaryLabel({ ...base, mode: "switch-model" })).toBe("Switch and continue");
  expect(handOffPrimaryLabel({ ...base, mode: "switch-model", submitting: true })).toBe(
    "Switching…",
  );
});
