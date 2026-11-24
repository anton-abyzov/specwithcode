// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  copyHandlers,
  CopyFixture,
  copyStatus,
  findButton,
  newRow,
  summary,
  type FixtureOptions,
} from "./HandoffFolderCopy.testkit";

// 1332: progress you can read on the paths the Sol review found without it.

const state = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
  handlers: {} as Record<string, (input: unknown) => unknown>,
  uuid: 0,
  homes: {} as Record<string, string | null>,
  link: null as unknown as (...args: unknown[]) => Promise<unknown>,
  /** This window's access:write on the source, as the session reports it. */
  sourceAccess: "unknown" as "granted" | "denied" | "unknown",
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScopeAccess: () => state.sourceAccess,
  readEnvironmentScopeAccess: () => state.sourceAccess,
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
const settle = (ms = 0) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
const mount = (overrides: FixtureOptions = {}) =>
  act(async () => root.render(<CopyFixture {...overrides} />));
const track = () => container.querySelector<HTMLElement>('[data-slot="copy-phase-track"]');
const POINTER = "specwithcode:folder-copy:laptopE:source";
const pointer = (extra: Record<string, unknown> = {}) =>
  localStorage.setItem(
    POINTER,
    JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000009",
      environmentId: "kioskD",
      mode: "copy-only",
      targetFolder: "/target",
      projectId: null,
      ...extra,
    }),
  );

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
  await act(async () => root.unmount());
  container.remove();
});

it("shows the track while a Clone or Skip change compares again on Review (AC-01)", async () => {
  pointer({ method: "copy" });
  state.handlers.copySourceStatus = () => ({ state: "ready", summary, progress: null, error: null });
  const rows = [newRow("."), newRow("repos/app", { cloneAvailable: true })];
  statuses = [copyStatus("previewed", { rows }), copyStatus("previewed", { rows })];
  await mount();
  await settle();
  expect(container.querySelector('[data-slot="copy-recompare"]')).toBeNull();
  await act(async () =>
    container
      .querySelector<HTMLElement>(`[aria-label="Copy repos/app"]`)!
      .click(),
  );
  // The review stays; above it the step, the three phases and that it can run on closed.
  const panel = container.querySelector('[data-slot="copy-recompare"]')!;
  expect(panel.querySelector('[data-slot="copy-working"]')?.textContent).toBe(
    "Comparing again with your choices…",
  );
  expect(track()?.getAttribute("data-phase")).toBe("measure");
  expect(panel.textContent).toContain("You can close this window");
  expect(container.querySelector('[data-slot="copy-preview"]')).not.toBeNull();
  await settle(600);
  expect(container.querySelector('[data-slot="copy-recompare"]')).toBeNull();
});

it("sends a Clone or Skip change still waiting when the dialog closes (AC-04)", async () => {
  pointer({ method: "copy" });
  state.handlers.copySourceStatus = () => ({ state: "ready", summary, progress: null, error: null });
  const rows = [newRow("."), newRow("repos/app", { cloneAvailable: true })];
  statuses = [copyStatus("previewed", { rows })];
  await mount();
  await settle();
  await act(async () =>
    container.querySelector<HTMLElement>(`[aria-label="Copy repos/app"]`)!.click(),
  );
  expect(names()).not.toContain("copyDecide");
  // Run in background closes the dialog before the clicks settle.
  await act(async () => root.render(<></>));
  await settle();
  const decided = state.calls.filter(([name]) => name === "copyDecide");
  expect(decided).toHaveLength(1);
  expect(decided[0]![1]).toMatchObject({
    environmentId: "kioskD",
    input: { operationId: "00000000-0000-4000-8000-000000000009", skip: ["repo:repos/app"] },
  });
});

it("shows the track stopped at Measure when the source cannot read the folder (AC-05)", async () => {
  const offer = state.handlers.copyOffer!;
  state.handlers.copyOffer = (input) => ({
    ...(offer(input) as object),
    status: { state: "scanning", summary: null, progress: null, error: null },
  });
  state.handlers.copySourceStatus = () => ({
    state: "failed",
    summary: null,
    progress: null,
    error: "The folder could not be read.",
  });
  await mount();
  expect(track()).toBeNull();
  await act(async () => findButton(container, "Copy to Kiosk D").click());
  await settle(1100);
  expect(container.querySelector('[data-slot="handoff-folder-copy"]')?.getAttribute("data-stage")).toBe(
    "setup",
  );
  expect(track()?.getAttribute("data-outcome")).toBe("failed");
  expect(track()?.getAttribute("data-phase")).toBe("measure");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "The folder could not be read.",
  );
});

it("shows the track stopped at Measure for a reopened copy whose measuring failed (AC-05)", async () => {
  pointer();
  state.handlers.copyStatus = () => {
    throw Object.assign(new Error("gone"), { _tag: "FolderCopyError", code: "not_found" });
  };
  state.handlers.copySourceStatus = () => ({
    state: "failed",
    summary: null,
    progress: null,
    error: "The folder could not be read.",
  });
  await mount();
  await settle();
  expect(track()?.getAttribute("data-outcome")).toBe("failed");
  expect(track()?.getAttribute("data-phase")).toBe("measure");
});

it("says Sent 0 B in 0 files on Done when nothing had to move (AC-05)", async () => {
  pointer();
  statuses = [
    copyStatus("applied", {
      totals: { filesToMove: 0, bytesToMove: 0, bytesPresent: 50, decisionsNeeded: 0 },
    }),
  ];
  await mount();
  await settle();
  expect(container.querySelector('[data-slot="copy-done-duration"]')?.textContent).toContain(
    "Sent 0 B in 0 files",
  );
});
