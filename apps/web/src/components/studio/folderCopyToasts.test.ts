import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => ({
  added: [] as Array<{ id: string; options: { title?: unknown; data?: { progress?: number } } }>,
  updated: [] as Array<{ id: string; options: { title?: unknown; data?: { progress?: number } } }>,
  closed: [] as string[],
}));
vi.mock("../ui/toast", () => ({
  hiddenToastActionProps: {},
  stackedThreadToast: (options: unknown) => options,
  toastManager: {
    add: (options: never) => {
      const id = `toast-${toasts.added.length + 1}`;
      toasts.added.push({ id, options });
      return id;
    },
    update: (id: string, options: never) => toasts.updated.push({ id, options }),
    close: (id: string) => toasts.closed.push(id),
  },
}));

import type { CopyActivity, CopyWatch } from "../../studio/folderCopyActivity";
import { resetCopyToastsForTests, syncCopyToasts } from "./folderCopyToasts";

const watch: CopyWatch = {
  environmentId: "m4",
  projectId: "source",
  machineLabel: () => "m5",
  sourceLabel: "m4",
};
const sending = (fraction: number): CopyActivity => ({
  machine: "m5",
  label: "Copying files",
  fraction,
  waiting: false,
  source: "m4",
  progress: {
    phase: "send",
    step: "Sending files to m5",
    fraction,
    bytes: { done: fraction * 8_000_000_000, total: 8_000_000_000 },
    files: { done: Math.round(fraction * 4000), total: 4000 },
    bytesLocal: 0,
    rateKey: "send:files",
    outcome: "running",
  },
});

beforeEach(() => {
  resetCopyToastsForTests();
  toasts.added = [];
  toasts.updated = [];
  toasts.closed = [];
});
afterEach(() => resetCopyToastsForTests());

it("keeps one progress toast for a copy running with its dialog closed, then closes it", () => {
  const watches = new Map([["m4:source", watch]]);
  syncCopyToasts(new Map([["m4:source", sending(0.25)]]), watches);
  expect(toasts.added).toHaveLength(1);
  expect(toasts.added[0]!.options.title).toBe("Copy to m5: sending files to m5, 25%");
  // Send is the second of three phases: the toast's bar shows the whole copy.
  expect(toasts.added[0]!.options.data?.progress).toBeCloseTo((1 + 0.25) / 3);
  syncCopyToasts(new Map([["m4:source", sending(0.5)]]), watches);
  expect(toasts.added).toHaveLength(1);
  expect(toasts.updated.at(-1)!.id).toBe("toast-1");
  expect(toasts.updated.at(-1)!.options.data?.progress).toBeCloseTo(0.5);
  // Finished: the watcher announces it; the progress toast goes.
  syncCopyToasts(new Map(), watches);
  expect(toasts.closed).toEqual(["toast-1"]);
});

it("shows no toast while the dialog follows the copy, or while it waits for review", () => {
  syncCopyToasts(new Map([["m4:source", sending(0.25)]]), new Map());
  syncCopyToasts(
    new Map([["m4:source", { ...sending(0), waiting: true }]]),
    new Map([["m4:source", watch]]),
  );
  expect(toasts.added).toHaveLength(0);
});
