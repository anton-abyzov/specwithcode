// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { copyHandlers, CopyFixture, copyStatus, findButton } from "./HandoffFolderCopy.testkit";

// A move a busy machine refused: the threads it named, each opening that thread, and what
// to do about them. Older machines name none and keep the plain notice.
const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
  uuid: 0,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, onClick, className }: any) => (
    <a
      className={className}
      href={to
        .replace("$environmentId", params.environmentId)
        .replace("$threadId", params.threadId)}
      onClick={(event) => {
        event.preventDefault();
        onClick?.(event);
      }}
    >
      {children}
    </a>
  ),
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

const PROJECT = "00000000-0000-4000-8000-000000000002";
const named = (total: number, count = total) => ({
  total,
  threads: [
    {
      threadId: "lanes",
      title: "1050 repair lanes C and D",
      projectId: "source",
      projectTitle: "Project",
      reason: "waiting_for_answer",
    },
    {
      threadId: "review",
      title: "1048 fresh review r2",
      projectId: "other",
      projectTitle: "Old registration",
      reason: "running",
    },
  ].slice(0, count),
});
const busyError = (busy?: unknown) =>
  Object.assign(new Error("Finish active work in this project before handing it off."), {
    code: "busy",
    ...(busy ? { busy } : {}),
  });

let root: Root;
let container: HTMLDivElement;
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const click = async (label: string) => {
  await act(async () => findButton(container, label).click());
  await settle();
};
const handOff = async () => {
  await act(async () => root.render(<CopyFixture />));
  await settle();
  await act(async () => {
    [...container.querySelectorAll<HTMLElement>('[data-slot="toggle"]')]
      .find((node) => node.textContent === "Hand off and continue there")!
      .click();
  });
  await click("Hand off to M3");
  await click("Hand off to M3");
};
const links = () =>
  [...container.querySelectorAll<HTMLAnchorElement>('[data-slot="handoff-busy-thread"] a')].map(
    (node) => [node.textContent, node.getAttribute("href")],
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  state.calls = [];
  state.uuid = 0;
  const statuses = [
    copyStatus("previewed", { mode: "copy-and-move" }),
    copyStatus("applied", { mode: "copy-and-move", projectId: PROJECT }),
  ];
  state.handlers = copyHandlers({
    calls: () => state.calls,
    nextStatus: () =>
      statuses.shift() ?? copyStatus("applied", { mode: "copy-and-move", projectId: PROJECT }),
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("names the source threads that keep the coordinator there, each opening its thread", async () => {
  state.handlers.prepare = () => {
    throw busyError(named(12));
  };
  await handOff();
  expect(container.textContent).toContain(
    "12 threads are still working or waiting for you on M4, so the coordinator stayed there.",
  );
  expect(container.textContent).toContain(
    "Answer or close each question, or stop the work, then try again.",
  );
  expect(links()).toEqual([
    ["1050 repair lanes C and D", "/m4/lanes"],
    ["1048 fresh review r2", "/m4/review"],
  ]);
  const rows = [...container.querySelectorAll('[data-slot="handoff-busy-thread"]')];
  expect(rows.map((row) => row.getAttribute("data-reason"))).toEqual([
    "waiting_for_answer",
    "running",
  ]);
  expect(rows[0]!.textContent).toContain("Waiting for your answer");
  // Only a thread of another project on the same folder says its project.
  expect(rows[0]!.textContent).not.toContain("Project");
  expect(rows[1]!.textContent).toContain("Old registration");
  expect(container.textContent).toContain("And 10 more threads on M4.");
});

it("links a destination's busy threads on the destination", async () => {
  state.handlers.receive = ({ input }: any) => {
    if (input.mode === "preview") throw busyError(named(1, 1));
    return { phase: "started" };
  };
  await handOff();
  expect(container.textContent).toContain(
    "A thread is still working or waiting for you on M3, so the coordinator stayed on M4.",
  );
  expect(links()).toEqual([["1050 repair lanes C and D", "/m3/lanes"]]);
});

it("keeps the plain notice from an older source that names no threads", async () => {
  state.handlers.prepare = () => {
    throw busyError();
  };
  await handOff();
  expect(container.textContent).toContain(
    "Work is still running on M4, so the coordinator stayed there.",
  );
  expect(container.querySelector('[data-slot="handoff-busy-threads"]')).toBeNull();
});
