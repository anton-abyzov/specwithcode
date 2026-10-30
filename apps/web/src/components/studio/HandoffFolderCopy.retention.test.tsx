// @vitest-environment jsdom
// A large project moves its coordinator with a summary of its workers; an older destination cannot read it.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  copyHandlers,
  CopyFixture,
  copyStatus,
  findButton,
  type FixtureOptions,
} from "./HandoffFolderCopy.testkit";

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
vi.mock("./ProjectLinkDialog", () => ({
  ProjectLinkDialog: (props: { initialCandidate: unknown; initialKept: string }) => (
    <div data-slot="link-dialog">{JSON.stringify([props.initialCandidate, props.initialKept])}</div>
  ),
}));
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
  MachineReadinessChecklist: (props: { environmentId: string; projectId: string }) => (
    <p data-slot="readiness-stub">
      Readiness {props.environmentId} {props.projectId}
    </p>
  ),
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
const names = () => state.calls.map(([name]) => name);
const button = (label: string) => findButton(container, label);
const click = async (label: string) => {
  await act(async () => button(label).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const mount = (overrides: FixtureOptions = {}) =>
  act(async () => root.render(<CopyFixture {...overrides} />));
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

const retention = {
  note: "Worker chats did not move.",
  coordinatorMessages: 412,
  omittedMessages: 9418,
  truncatedMessages: 0,
  totalThreads: 1628,
  workers: Array.from({ length: 200 }, (_, i) => ({ threadId: `worker-${i}` })),
  omittedThreads: 1428,
};
const summarized = (capabilities: Record<string, unknown>, value: object = retention) => {
  const base = state.handlers;
  state.handlers = {
    ...base,
    copyCapabilities: () => capabilities,
    prepare: (request) => {
      const prepared = base.prepare!(request) as { bundle: Record<string, unknown> };
      return {
        ...prepared,
        bundle: {
          ...prepared.bundle,
          context: { goal: "", instructions: "", notes: [], threads: [], retention: value },
        },
      };
    },
  };
};
const moveToM3 = async () => {
  statuses = [
    copyStatus("previewed", { mode: "copy-and-move" }),
    copyStatus("applied", {
      mode: "copy-and-move",
      projectId: "00000000-0000-4000-8000-000000000002",
    }),
  ];
  await mount();
  const move = [...container.querySelectorAll<HTMLElement>('[data-slot="toggle"]')].find(
    (node) => node.textContent === "Hand off and continue there",
  )!;
  await act(async () => move.click());
  await click("Hand off to M3");
  await click("Hand off to M3");
};
const published = () =>
  state.calls.filter(
    ([name, request]) => name === "prepare" && (request as any).input.publish === true,
  );

it("refuses before fencing when the destination cannot read a summarized handoff", async () => {
  summarized({ scopeVersion: 1 });
  await moveToM3();
  expect(state.calls.find(([name]) => name === "copyCapabilities")?.[1]).toMatchObject({
    environmentId: "m3",
  });
  expect(published()).toHaveLength(0);
  expect(names().filter((name) => name === "receive")).toHaveLength(1);
  expect(container.textContent).toContain(
    "Update the other machine to move the coordinator of a project this large. Nothing moved; the coordinator stays here.",
  );
  expect(container.textContent).not.toContain("The coordinator now runs on M3.");
});

it("moves a summarized coordinator to a destination that reads it and says what stayed", async () => {
  summarized({ scopeVersion: 1, contextRetention: 1 });
  await moveToM3();
  expect(published()).toHaveLength(1);
  // The source fences a summarized bundle only on this confirmation.
  expect((published()[0]![1] as any).input.contextRetention).toBe(1);
  expect(container.textContent).toContain("The coordinator now runs on M3.");
  expect(container.querySelector('[data-slot="copy-done-retention"]')?.textContent).toBe(
    "The coordinator moved with its latest 412 messages. 9,418 older messages and 1,628 worker chats stay on M4; M3 has a summary of the 200 most recent workers.",
  );
});

it("names the machines the chats were written on after an earlier summarized handoff", async () => {
  summarized(
    { scopeVersion: 1, contextRetention: 1 },
    {
      ...retention,
      machines: [
        { environmentId: "m4", totalThreads: 0, omittedThreads: 0, omittedMessages: 0 },
        { environmentId: "m3", totalThreads: 1628, omittedThreads: 1428, omittedMessages: 9418 },
      ],
    },
  );
  await moveToM3();
  expect(container.querySelector('[data-slot="copy-done-retention"]')?.textContent).toBe(
    "The coordinator moved with its latest 412 messages. 9,418 older messages and 1,628 worker chats stay on the machines they were written on; M3 has a summary of the 200 most recent workers.",
  );
});

it("moves a small project without asking the destination about summaries", async () => {
  await moveToM3();
  expect(names()).not.toContain("copyCapabilities");
  expect(published()).toHaveLength(1);
  expect((published()[0]![1] as any).input).not.toHaveProperty("contextRetention");
  expect(container.querySelector('[data-slot="copy-done-retention"]')).toBeNull();
});
