// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { container, render, shell, state } from "./ProjectWorkspace.test-fixtures";

// The progress read is keyed by the project's thread ids, like the real hook: a
// new id list has no answer until its read resolves.
const reads = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let version = 0;
  return {
    answerAtOnce: true,
    unplanned: new Set<string>(["worker"]),
    answers: new Map<string, ReadonlySet<string>>(),
    pending: new Set<string>(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => version,
    answerPending() {
      for (const key of this.pending) this.answers.set(key, new Set(this.unplanned));
      this.pending.clear();
      version += 1;
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("../../studio/useThreadIncrementProgress", async (importOriginal) => {
  const react = await import("react");
  const actual = await importOriginal<object>();
  return {
    ...actual,
    useProjectThreadIncrementProgress: (
      environmentId: string,
      threads: ReadonlyArray<{ id: string; environmentId: string; archivedAt: string | null }>,
    ) => {
      react.useSyncExternalStore(reads.subscribe, reads.version);
      const key = threads
        .filter((thread) => thread.environmentId === environmentId && thread.archivedAt === null)
        .map((thread) => thread.id)
        .toSorted()
        .join(",");
      if (!reads.answers.has(key)) {
        if (reads.answerAtOnce) reads.answers.set(key, new Set(reads.unplanned));
        else reads.pending.add(key);
      }
      const unplanned = reads.answers.get(key);
      return unplanned === undefined
        ? { progress: new Map(), unplanned: new Set(), answered: false }
        : { progress: new Map(), unplanned, answered: true };
    },
  };
});

const filter = () => container.querySelector<HTMLButtonElement>("[data-unplanned-filter]");

beforeEach(() => {
  reads.answerAtOnce = true;
  reads.unplanned = new Set(["worker"]);
  reads.answers.clear();
  reads.pending.clear();
  window.localStorage.clear();
});

it("keeps a pressed filter while a new thread's progress read is in flight", async () => {
  await render();
  await act(async () => filter()!.click());
  expect(filter()!.getAttribute("aria-pressed")).toBe("true");

  reads.answerAtOnce = false;
  state.shells = [...state.shells, shell("worker2")];
  await render();
  // Nothing is known yet, so the notice steps aside without letting go.
  expect(filter()).toBeNull();

  await act(async () => reads.answerPending());
  expect(filter()!.getAttribute("aria-pressed")).toBe("true");
  const rows = [
    ...container.querySelectorAll('[data-project-pane="threads"] [data-thread-id]'),
  ].map((node) => node.getAttribute("data-thread-id"));
  expect(rows).toEqual(["worker"]);
});

it("lets the filter go once an answered read counts nothing", async () => {
  await render();
  await act(async () => filter()!.click());
  expect(filter()!.getAttribute("aria-pressed")).toBe("true");

  // The thread was linked: the next read answers with no unplanned threads.
  reads.unplanned = new Set();
  state.shells = [...state.shells, shell("worker2")];
  await render();
  expect(filter()).toBeNull();

  // A later unplanned thread brings the notice back unpressed.
  reads.unplanned = new Set(["worker3"]);
  state.shells = [...state.shells, shell("worker3")];
  await render();
  expect(filter()!.getAttribute("aria-pressed")).toBe("false");
});
