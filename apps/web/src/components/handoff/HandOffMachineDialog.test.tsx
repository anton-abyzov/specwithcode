// @vitest-environment jsdom
import type { EnvironmentId, HandoffPreflightResult, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
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

it("migrates one project's threads with a preflight result per thread", async () => {
  const view = props();
  await act(async () => root.render(<HandOffMachineDialogView {...view} />));
  const text = document.body.textContent ?? "";
  expect(text).toContain("Migrate threads…");
  expect(text).toContain("atlas's running threads in handoff mode on M4");
  expect(text).toContain("The coordinator stays where it is.");
  expect(text).toContain("Ready. Its turn continues there.");
  expect(text).toContain("Stays here: a check failed.");
  expect(text).toContain("Minis: no .env.local");
  // Only the thread that passed its checks moves.
  const submit = [...document.querySelectorAll("button")].find((button) =>
    button.textContent?.startsWith("Hand off"),
  );
  expect(submit?.textContent).toBe("Hand off 1 thread");
  await act(async () => submit!.click());
  expect(view.onSubmit).toHaveBeenCalledTimes(1);
});

it("keeps the whole-machine wording without a project", async () => {
  await act(async () =>
    root.render(<HandOffMachineDialogView {...props({ projectName: null, threads: [] })} />),
  );
  const text = document.body.textContent ?? "";
  expect(text).toContain("Hand off this machine…");
  expect(text).toContain("No thread in handoff mode is running here.");
});

it("says when the project has no running handoff-mode thread", async () => {
  await act(async () => root.render(<HandOffMachineDialogView {...props({ threads: [] })} />));
  expect(document.body.textContent).toContain(
    "No thread of atlas in handoff mode is running on M4.",
  );
});
