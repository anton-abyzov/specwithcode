// @vitest-environment jsdom
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

// Secrets from a window that may not send them (signed in to the source through Connect).

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
const dialogButton = (label: string) => {
  const matches = [...document.querySelectorAll<HTMLButtonElement>("button")].filter(
    (element) => element.textContent?.trim() === label,
  );
  expect(matches).toHaveLength(1);
  const result = matches[0]!;
  expect(result.closest('[data-slot="dialog-footer"]')).not.toBeNull();
  expect(result.closest('[data-slot="scroll-area-viewport"]')).toBeNull();
  return result;
};
const dialogClick = async (label: string) => {
  await act(async () => dialogButton(label).click());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

beforeEach(() => {
  state.sourceAccess = "unknown";
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
const KEY = "specwithcode:folder-copy:m4:source";
const sentSecrets = () =>
  state.calls
    .filter(([name]) => name === "copySecrets")
    .map(([, request]) => (request as { input: { paths: string[] } }).input.paths);
const stagedOnSource = (files: Array<{ path: string; size: number }>) => {
  const read = state.handlers.copySourceStatus!;
  state.handlers.copySourceStatus = async (input) => ({
    ...((await read(input)) as object),
    secrets: files.length ? { files, approvedAt: 1, destinationLabel: "M3" } : null,
  });
};

it("copies without secrets, and says where to send them from, in a window that may not send them", async () => {
  // A window on another machine (signed in through Connect) holds no access:write there.
  state.sourceAccess = "denied";
  try {
    statuses = [copyStatus("previewed"), copyStatus("applied")];
    await mount();
    const along = container.querySelector('[data-slot="copy-along-secrets"]')!;
    expect(along.textContent).toContain("Secrets (.env, keys): left on M4");
    expect(along.textContent).toContain(
      "Only SpecWithCode on M4 can send secrets. To include them, start this copy in the SpecWithCode window on M4.",
    );
    expect(along.querySelector('[data-slot="checkbox"]')!.hasAttribute("data-disabled")).toBe(true);
    await click("Copy to M3");
    expect(container.textContent).toContain("Secrets (.env, keys): 1 file, left on M4");
    await click("Copy to M3");
    // Approval goes ahead; nothing asks the source for a grant this window lacks.
    expect(names()).toContain("copyApprove");
    expect(names()).not.toContain("copySecrets");
    expect(container.textContent).not.toContain("requires access:write");
  } finally {
    state.sourceAccess = "unknown";
  }
});

it("takes secrets staged earlier off the source before approving from that window", async () => {
  // M4's own window staged .env; this window retries the copy without access:write there.
  state.sourceAccess = "denied";
  stagedOnSource([{ path: ".env", size: 10 }]);
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await click("Copy to M3");
  await click("Copy to M3");
  expect(sentSecrets()).toEqual([[]]);
  expect(names().indexOf("copySecrets")).toBeLessThan(names().indexOf("copyApprove"));
});

it("stops before approval when staged secrets cannot be taken off", async () => {
  state.sourceAccess = "denied";
  stagedOnSource([{ path: ".env", size: 10 }]);
  state.handlers.copySecrets = () => {
    throw new Error("This connection requires access:write.");
  };
  statuses = [copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await click("Copy to M3");
  await click("Copy to M3");
  expect(names()).not.toContain("copyApprove");
  expect(container.textContent).toContain(
    "Secrets are still set to go from M4, and this window can't take them off. Untick Secrets in the SpecWithCode window on M4, or update SpecWithCode on M4, then copy again.",
  );
});

it("keeps the person's secrets choice for a window that may send them", async () => {
  state.sourceAccess = "denied";
  statuses = [copyStatus("previewed"), copyStatus("previewed"), copyStatus("applied")];
  await mount();
  await click("Copy to M3");
  // The saved copy still says Secrets included; only this window leaves them out.
  expect(JSON.parse(localStorage.getItem(KEY)!).secrets).toEqual({ included: true, out: [] });
  await act(async () => root.unmount());
  root = createRoot(container);
  state.sourceAccess = "granted";
  await mount();
  expect(container.textContent).toContain("Secrets (.env, keys): 1 file, included");
  await click("Copy to M3");
  expect(sentSecrets()).toEqual([[".env"]]);
});
