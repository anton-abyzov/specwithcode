// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  copyHandlers,
  CopyFixture,
  copyStatus,
  findButton,
  openMore,
  type FixtureOptions,
} from "./HandoffFolderCopy.testkit";

// A move the source refused because files changed after copying: the list, its three
// choices, the accepted list kept across a reopen, and what the move left on the source.
const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
  uuid: 0,
}));
vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: true }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (input: { environmentId: string } | null) => ({
    data: input ? { parentPath: "/home/anton", entries: [] } : null,
    isPending: false,
  }),
}));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../studio/projectLink", () => ({
  projectLink: new Proxy({}, { get: (_target, name) => `link:${String(name)}` }),
  linkCopyAsWorkers: async () => ({ status: "linked" }),
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

const KEY = "specwithcode:folder-copy:m4:source";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const LEDGER = ".specweave/increments/0001-move/ledger.jsonl";
const changes = (overrides: Record<string, unknown> = {}) => ({
  digest: "a".repeat(64),
  total: 3,
  truncated: false,
  acceptable: true,
  rows: [
    { path: LEDGER, kind: "changed", size: 2048 },
    { path: ".specweave/increments/0002-new/spec.md", kind: "added", size: 100 },
    {
      path: "repositories/org/app",
      kind: "repository",
      repository: {
        headFrom: "a1b2c3d4e5f6",
        headTo: "d4e5f6a1b2c3",
        branchesChanged: ["main"],
        stashFrom: 0,
        stashTo: 1,
        indexChanged: false,
      },
    },
  ],
  ...overrides,
});
const refusal = (list = changes()) =>
  Object.assign(
    new Error("Files changed on the source after the copy. Review them before moving."),
    { code: "source_changed", changes: list },
  );

let root: Root;
let container: HTMLDivElement;
let statuses: Array<Record<string, unknown>>;
const names = () => state.calls.map(([name]) => name);
const prepares = () =>
  state.calls
    .filter(([name]) => name === "prepare")
    .map(([, request]) => (request as { input: Record<string, unknown> }).input);
/** The coordinator was started on the destination. */
const started = () =>
  state.calls.some(
    ([name, request]) =>
      name === "receive" && (request as { input: { mode: string } }).input.mode === "start",
  );
const pointerNow = () => JSON.parse(localStorage.getItem(KEY) ?? "null");
const labels = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].map((node) =>
    node.textContent?.trim(),
  );
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const click = async (label: string) => {
  await act(async () => findButton(container, label).click());
  await settle();
};
const mount = async (overrides: FixtureOptions = {}) => {
  await act(async () => root.render(<CopyFixture {...overrides} />));
  await settle();
};
const remount = async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount();
};
const moveCopy = () => {
  statuses = [
    copyStatus("previewed", { mode: "copy-and-move", capturedAt: Date.now() - 5 * 60_000 }),
    copyStatus("applied", {
      mode: "copy-and-move",
      projectId: PROJECT,
      capturedAt: Date.now() - 5 * 60_000,
    }),
  ];
};
/** Measures, compares and copies with Hand off and continue there; the move then runs. */
const handOff = async () => {
  await act(async () => {
    [...container.querySelectorAll<HTMLElement>('[data-slot="toggle"]')]
      .find((node) => node.textContent === "Hand off and continue there")!
      .click();
  });
  await click("Hand off to M3");
  await click("Hand off to M3");
};
/** The source refuses until the person accepts exactly this list. */
const refuseUnlessAccepted = (list = changes()) => {
  state.handlers.prepare = ({ input }: any) => {
    if (input.publish && input.acceptedSourceChanges !== list.digest) throw refusal(list);
    return {
      publication: input.publish ? "published" : "unpublished",
      bundle: {
        digest: "d".repeat(64),
        manifest: { operationId: input.operationId, repositories: [] },
        destination: input.destination,
        sourceEnvironmentId: "m4",
        sourceProjectId: "source",
        sourceThreadId: "coordinator",
      },
    };
  };
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state.calls = [];
  state.uuid = 0;
  moveCopy();
  state.handlers = copyHandlers({
    calls: () => state.calls,
    nextStatus: () =>
      statuses.shift() ?? copyStatus("applied", { mode: "copy-and-move", projectId: PROJECT }),
  });
  state.handlers.copyDrift = () => ({
    drift: {
      digest: "b".repeat(64),
      total: 2,
      truncated: false,
      acceptable: true,
      rows: [
        { path: LEDGER, kind: "changed", size: 4096 },
        { path: "notes.md", kind: "added", size: 12 },
      ],
    },
    leftOnSource: { digest: "a".repeat(64), total: 3, recordedAt: Date.now() },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("names a repository whose only change is its refs or Git settings", async () => {
  const head = "a1b2c3d4e5f6";
  refuseUnlessAccepted(
    changes({
      total: 1,
      rows: [
        {
          path: ".",
          kind: "repository",
          repository: {
            headFrom: head,
            headTo: head,
            branchesChanged: [],
            stashFrom: 0,
            stashTo: 0,
            indexChanged: false,
            refsChanged: true,
            settingsChanged: true,
          },
        },
      ],
    }),
  );
  await mount();
  await handOff();
  const row = container.querySelector('[data-slot="source-change"]')!;
  expect(row.textContent).toContain("tags or other refs differ; Git settings or hooks differ");
});

it("lists the changed paths by folder with the three choices", async () => {
  refuseUnlessAccepted();
  await mount();
  await handOff();
  expect(container.textContent).toContain("3 paths changed on M4 after copying.");
  expect(container.textContent).not.toContain("Copy again before moving the coordinator");
  const list = container.querySelector('[data-slot="source-changes"]')!;
  expect(list.textContent).toContain("as they were 5 minutes ago");
  const groups = [...list.querySelectorAll('[data-slot="source-change-group"]')].map(
    (group) => group.querySelector("p")?.textContent,
  );
  expect(groups).toEqual([".specweave/", "Repositories"]);
  const rows = [...list.querySelectorAll('[data-slot="source-change"]')].map(
    (row) => row.textContent,
  );
  expect(rows[0]).toBe(`Changed${LEDGER}2.0 KB`);
  expect(rows[1]).toContain("New.specweave/increments/0002-new/spec.md");
  expect(rows[2]).toBe("Gitrepositories/org/appa1b2c3d → d4e5f6a; branch main; stashes 0 → 1");
  expect(labels()).toEqual(
    expect.arrayContaining([
      "Copy again",
      "Move without these 3 paths",
      "Keep the coordinator on M4",
    ]),
  );
  expect(labels()).not.toContain("Hand off coordinator now");
  expect(started()).toBe(false);
  // Nothing was accepted yet.
  expect(pointerNow()).not.toHaveProperty("acceptedSourceChanges");
});

it("says and more when the source cut the list short", async () => {
  refuseUnlessAccepted(changes({ total: 120, truncated: true }));
  await mount();
  await handOff();
  expect(container.querySelector('[data-slot="source-changes"]')?.textContent).toContain(
    "and 117 more.",
  );
  expect(labels()).toContain("Move without these 120 paths");
});

it("does not offer moving without the paths for an uncaptured copy", async () => {
  refuseUnlessAccepted(changes({ acceptable: false }));
  await mount();
  await handOff();
  expect(container.textContent).toContain("This copy was not captured");
  expect(labels()).toContain("Copy again");
  expect(labels()).toContain("Keep the coordinator on M4");
  expect(labels().some((label) => label?.startsWith("Move without"))).toBe(false);
});

it("moves without the paths, sends the list on both prepares and names what stayed", async () => {
  refuseUnlessAccepted();
  await mount();
  await handOff();
  const before = prepares().length;
  await click("Move without these 3 paths");
  const retried = prepares().slice(before);
  expect(retried.map((input) => input.publish)).toEqual([false, true]);
  for (const input of retried) expect(input.acceptedSourceChanges).toBe("a".repeat(64));
  expect(container.textContent).toContain("The coordinator now runs on M3.");
  expect(pointerNow()).toBeNull();
  expect(state.calls.find(([name]) => name === "copyDrift")?.[1]).toMatchObject({
    environmentId: "m4",
    input: { projectId: "source", operationId: retried[0]!.operationId },
  });
  const left = container.querySelector('[data-slot="copy-left-on-source"]')!;
  expect(left.textContent).toContain("2 paths differ on M4 from the copy on M3.");
  expect(left.querySelector('[aria-label="Left by your choice"]')?.textContent).toContain(LEDGER);
  expect(left.querySelector('[aria-label="Changed after the handoff"]')?.textContent).toContain(
    "notes.md",
  );
  expect(container.querySelector('[data-slot="source-changes"]')).toBeNull();
});

it("shows a fresh list when a new path changed since the one accepted", async () => {
  const newer = changes({ digest: "c".repeat(64), total: 4 });
  let first = true;
  refuseUnlessAccepted();
  const accepting = state.handlers.prepare!;
  state.handlers.prepare = (request: any) => {
    if (request.input.publish && request.input.acceptedSourceChanges && first) {
      first = false;
      throw refusal(newer);
    }
    return accepting(request);
  };
  await mount();
  await handOff();
  await click("Move without these 3 paths");
  expect(container.textContent).toContain("4 paths changed on M4 after copying.");
  expect(labels()).toContain("Move without these 4 paths");
  // The stale acceptance is gone, so a reopen asks again.
  expect(pointerNow()).not.toHaveProperty("acceptedSourceChanges");
});

it("keeps the accepted list across a reopen, and Copy again clears it", async () => {
  refuseUnlessAccepted();
  await mount();
  await handOff();
  // The source is busy on the accepted retry: the pointer keeps the choice.
  state.handlers.prepare = () => {
    throw Object.assign(new Error("busy"), { code: "busy" });
  };
  await click("Move without these 3 paths");
  expect(container.textContent).toContain("Work is still running on M4");
  expect(pointerNow().acceptedSourceChanges).toEqual({ digest: "a".repeat(64), total: 3 });

  statuses = [copyStatus("applied", { mode: "copy-and-move", projectId: PROJECT })];
  await remount();
  expect(pointerNow().acceptedSourceChanges).toEqual({ digest: "a".repeat(64), total: 3 });
  refuseUnlessAccepted();
  const before = prepares().length;
  await click("Hand off coordinator now");
  expect(
    prepares()
      .slice(before)
      .map((input) => input.acceptedSourceChanges),
  ).toEqual(["a".repeat(64), "a".repeat(64)]);
  expect(container.textContent).toContain("The coordinator now runs on M3.");
  // This browser no longer has the accepted rows: one list, not split.
  const left = container.querySelector('[data-slot="copy-left-on-source"]')!;
  expect(left.querySelector('[aria-label="Only on M4"]')?.textContent).toContain("notes.md");
  expect(left.querySelector('[aria-label="Left by your choice"]')).toBeNull();
});

it("keeps the list and its choices after a busy retry; Copy again drops the accepted list", async () => {
  refuseUnlessAccepted();
  await mount();
  await handOff();
  state.handlers.prepare = () => {
    throw Object.assign(new Error("busy"), { code: "busy" });
  };
  await click("Move without these 3 paths");
  const accepted = pointerNow();
  expect(accepted.acceptedSourceChanges).toBeDefined();
  expect(container.textContent).toContain("Work is still running on M4");
  expect(container.querySelector('[data-slot="source-changes"]')?.textContent).toContain(LEDGER);
  expect(labels()).toEqual(
    expect.arrayContaining([
      "Copy again",
      "Move without these 3 paths",
      "Keep the coordinator on M4",
    ]),
  );
  moveCopy();
  await click("Copy again");
  expect(names()).toContain("copyRelease");
  const fresh = pointerNow();
  expect(fresh.operationId).not.toBe(accepted.operationId);
  expect(fresh).not.toHaveProperty("acceptedSourceChanges");
});

it("Copy again from the list starts a fresh copy", async () => {
  refuseUnlessAccepted();
  await mount();
  await handOff();
  const first = pointerNow().operationId;
  moveCopy();
  await click("Copy again");
  expect(pointerNow().operationId).not.toBe(first);
  expect(names().filter((name) => name === "copyOffer")).toHaveLength(2);
});

it("keeps the coordinator on the source and leaves the copied files", async () => {
  refuseUnlessAccepted();
  await mount();
  await handOff();
  const operationId = pointerNow().operationId;
  await click("Keep the coordinator on M4");
  expect(state.calls.findLast(([name]) => name === "copyRelease")?.[1]).toMatchObject({
    environmentId: "m4",
    input: { projectId: "source", operationId },
  });
  expect(container.textContent).toContain(
    "The coordinator stays on M4. The copied files stay on M3.",
  );
  expect(container.querySelector('[data-slot="source-changes"]')).toBeNull();
  expect(labels()).not.toContain("Hand off coordinator now");
  expect(labels()).not.toContain("Keep the coordinator on M4");
  expect(labels()).toContain("Open on M3");
  expect(pointerNow()).toBeNull();
  expect(started()).toBe(false);
});

it("keeps today's notice when an older source sends no list", async () => {
  state.handlers.prepare = () => {
    throw Object.assign(new Error("changed"), { code: "source_changed" });
  };
  await mount();
  await handOff();
  expect(container.textContent).toContain("Copy again before moving the coordinator");
  expect(container.querySelector('[data-slot="source-changes"]')).toBeNull();
  expect(labels()).toContain("Copy again");
  expect(labels().some((label) => label?.startsWith("Move without"))).toBe(false);
  expect(labels()).not.toContain("Keep the coordinator on M4");
});

it("finishes the move quietly when a source answers the drift read without a list", async () => {
  const rejections: unknown[] = [];
  const collect = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", collect);
  try {
    state.handlers.copyDrift = () => ({});
    await mount();
    await handOff();
    await settle();
    expect(container.textContent).toContain("The coordinator now runs on M3.");
    expect(names()).toContain("copyDrift");
    expect(container.querySelector('[data-slot="copy-left-on-source"]')).toBeNull();
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", collect);
  }
});

it("says nothing more after a move when nothing is left on the source", async () => {
  state.handlers.copyDrift = () => ({
    drift: { digest: "b".repeat(64), total: 0, truncated: false, acceptable: true, rows: [] },
  });
  await mount();
  await handOff();
  expect(container.textContent).toContain("The coordinator now runs on M3.");
  expect(names()).toContain("copyDrift");
  expect(container.querySelector('[data-slot="copy-left-on-source"]')).toBeNull();
});

it("says removed paths stay in the copy and files copied mid-write may be incomplete", async () => {
  refuseUnlessAccepted(
    changes({
      total: 2,
      rows: [
        { path: LEDGER, kind: "changed", size: 2048, unsettled: true },
        { path: "notes/old.md", kind: "removed", size: 10 },
      ],
    }),
  );
  await mount();
  await handOff();
  const list = container.querySelector('[data-slot="source-changes"]')!;
  const rows = [...list.querySelectorAll('[data-slot="source-change"]')].map(
    (row) => row.textContent,
  );
  expect(rows[0]).toContain("Copied mid-write");
  expect(list.textContent).toContain(
    "The removed path is gone from M4 but still in the copy on M3",
  );
  expect(list.textContent).toContain(
    "A file was still being written when copied, so the copy on M3 may be incomplete.",
  );
  state.handlers.copyDrift = () => ({
    drift: {
      digest: "b".repeat(64),
      total: 1,
      truncated: false,
      acceptable: true,
      rows: [{ path: "notes/old.md", kind: "removed", size: 10 }],
    },
  });
  await click("Move without these 2 paths");
  const left = container.querySelector('[data-slot="copy-left-on-source"]')!;
  expect(left.textContent).toContain("1 path differs on M4 from the copy on M3.");
  expect(left.textContent).toContain(
    "The removed path is gone from M4 but still in the copy on M3",
  );
});

it("never shows a drift read that lands after Start a new copy", async () => {
  let answer!: (value: unknown) => void;
  let reads = 0;
  state.handlers.copyDrift = () =>
    ++reads === 1
      ? new Promise((resolve) => (answer = resolve))
      : {
          drift: { digest: "b".repeat(64), total: 0, truncated: false, acceptable: true, rows: [] },
        };
  await mount();
  await handOff();
  expect(container.textContent).toContain("The coordinator now runs on M3.");
  await openMore();
  await click("Start a new copy");
  moveCopy();
  await handOff();
  expect(reads).toBe(2);
  expect(container.textContent).toContain("The coordinator now runs on M3.");
  // The first move's read answers last: it must not land on the second move's screen.
  await act(async () =>
    answer({
      drift: {
        digest: "c".repeat(64),
        total: 1,
        truncated: false,
        acceptable: true,
        rows: [{ path: "stale.md", kind: "added", size: 1 }],
      },
    }),
  );
  await settle();
  expect(container.querySelector('[data-slot="copy-left-on-source"]')).toBeNull();
  expect(container.textContent).not.toContain("stale.md");
});
