import type { StorageCleanupPlan, StorageCleanupPlanItem } from "@specweave-studio/contracts";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const atoms = vi.hoisted(() => ({
  plan: Symbol("get-storage-cleanup-plan"),
  run: Symbol("run-storage-cleanup"),
}));
const state = vi.hoisted(() => ({
  canWrite: true,
  capable: true,
  machines: ["env-m4"] as Array<string>,
  getPlan: vi.fn(),
  runCleanup: vi.fn(),
}));

vi.mock("../../state/server", () => ({
  serverEnvironment: { getStorageCleanupPlan: atoms.plan, runStorageCleanup: atoms.run },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => (atom === atoms.plan ? state.getPlan : state.runCleanup),
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => state.canWrite,
  useEnvironmentScope: () => state.canWrite,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    connectedEnvironments: state.machines.map((environmentId) => ({
      environmentId,
      label: environmentId === "env-m4" ? "MacBook M4" : "MacBook M1",
      serverConfig: {
        environment: { capabilities: state.capable ? { storageCleanupPlan: true } : {} },
      },
    })),
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
    children,
  }: {
    title: string;
    description: string;
    control: ReactNode;
    children: ReactNode;
  }) => (
    <div data-row={title}>
      <p>{description}</p>
      {control}
      {children}
    </div>
  ),
}));
vi.mock("../ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

import { StorageCleanupPlanSection } from "./StorageCleanupPlanSection";

const item = (overrides: Partial<StorageCleanupPlanItem>): StorageCleanupPlanItem => ({
  kind: "worktree",
  path: "/Users/me/.specwithcode/worktrees/app/1370-cleanup",
  action: "remove",
  reason: "merged",
  detail: null,
  bytes: null,
  threadId: null,
  threadTitle: null,
  threadCount: 1,
  ...overrides,
});

const MERGED = item({
  bytes: 512_000_000,
  threadId: "thread-1",
  threadTitle: "Clean up finished worktrees",
});
const DOWNLOADS = item({
  kind: "interrupted-downloads",
  path: "/Users/me/.specwithcode/verify/app/.git",
  reason: "interrupted-downloads",
  detail: "4 files",
  bytes: 800_000_000,
});
const UNPUSHED = item({
  path: "/Users/me/.specwithcode/worktrees/app/1371-open",
  action: "keep",
  reason: "unpushed",
  detail: "feature/open",
  threadTitle: "Still working",
});

const PLAN: StorageCleanupPlan = {
  checkedAt: "2026-11-16T12:00:00.000Z",
  items: [MERGED, UNPUSHED, DOWNLOADS],
  removableBytes: 1_312_000_000,
  complete: false,
};
const AFTER: StorageCleanupPlan = { ...PLAN, items: [UNPUSHED], removableBytes: 0, complete: true };

let renderer: ReactTestRenderer;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  state.canWrite = true;
  state.capable = true;
  state.machines = ["env-m4"];
  state.getPlan.mockReset();
  state.runCleanup.mockReset();
  state.getPlan.mockResolvedValue({ _tag: "Success", value: PLAN });
  state.runCleanup.mockResolvedValue({
    _tag: "Success",
    value: { removed: [MERGED.path, DOWNLOADS.path], removedBytes: 1_312_000_000, plan: AFTER },
  });
});
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
});

const mount = () =>
  act(() => {
    renderer = create(<StorageCleanupPlanSection />);
  });
const text = () => {
  const parts: Array<string> = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") parts.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === "object" && "children" in node)
      walk((node as { children: unknown }).children);
  };
  walk(renderer.toJSON());
  return parts.join("");
};
const button = (marker: string): ReactTestInstance =>
  renderer.root.find((node) => node.type === "button" && node.props[marker] === "");
const press = async (target: ReactTestInstance) => {
  await act(async () => {
    target.props.onClick();
  });
};
const reasonOf = (path: string) =>
  renderer.root
    .find((node) => node.type === "li" && node.props.title === path)
    .find((node) => node.type === "p" && node.props["data-reason"] !== undefined).children;

describe("StorageCleanupPlanSection", () => {
  it("loads nothing until Check, then lists what would go and what stays with the reason", async () => {
    mount();
    expect(text()).toContain("Shows what the cleanup would remove");
    expect(state.getPlan).not.toHaveBeenCalled();
    expect(button("data-storage-cleanup-run").props.disabled).toBe(true);

    await press(button("data-storage-cleanup-check"));

    expect(state.getPlan).toHaveBeenCalledWith({ environmentId: "env-m4", input: {} });
    const shown = text();
    expect(shown).toContain("At least 1.3 GB would be freed.");
    expect(shown).toContain(
      "Dependency folders are left out: their files are shared with the package store. Some sizes could not be measured.",
    );
    expect(renderer.root.findByProps({ "aria-label": "Would be removed" })).toBeTruthy();
    expect(renderer.root.findByProps({ "aria-label": "Kept" })).toBeTruthy();
    // A worktree row: folder name, chat title, size and the reason in words.
    expect(shown).toContain("app/1370-cleanup");
    expect(shown).toContain("Clean up finished worktrees");
    expect(shown).toContain("512 MB");
    expect(reasonOf(MERGED.path)).toEqual(["Its pull request merged."]);
    expect(reasonOf(UNPUSHED.path)).toEqual(["It has commits that are not pushed. (feature/open)"]);
    // Leftover download files read as such, not as a folder name.
    expect(shown).toContain("Leftover files of stopped downloads");
    expect(button("data-storage-cleanup-check").children).toEqual(["Check again"]);
    expect(button("data-storage-cleanup-run").props.disabled).toBe(false);
  });

  it("runs Clean up now, says what it removed and shows the plan the run returned", async () => {
    mount();
    await press(button("data-storage-cleanup-check"));
    await press(button("data-storage-cleanup-run"));

    expect(state.runCleanup).toHaveBeenCalledWith({ environmentId: "env-m4", input: {} });
    const shown = text();
    expect(shown).toContain("Removed 2 folders, at least 1.3 GB.");
    expect(shown).toContain("Nothing to remove right now.");
    expect(shown).not.toContain("app/1370-cleanup");
    expect(shown).not.toContain("Some sizes could not be measured.");
    expect(shown).toContain("app/1371-open");
    expect(button("data-storage-cleanup-run").props.disabled).toBe(true);
  });

  it("shows the error when the check fails", async () => {
    state.getPlan.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("The Git host did not answer")),
    });
    mount();
    await press(button("data-storage-cleanup-check"));
    const alert = renderer.root.find((node) => node.type === "p" && node.props.role === "alert");
    expect(alert.children.join("")).toContain("The Git host did not answer");
    expect(text()).not.toContain("would be freed");
  });

  it("shows the first 20 rows of a long group until Show all", async () => {
    state.getPlan.mockResolvedValue({
      _tag: "Success",
      value: {
        ...PLAN,
        items: Array.from({ length: 25 }, (_, index) =>
          item({ path: `/Users/me/.specwithcode/worktrees/app/chat-${index}` }),
        ),
      },
    });
    mount();
    await press(button("data-storage-cleanup-check"));
    const rows = () => renderer.root.findAll((node) => node.type === "li").length;
    expect(rows()).toBe(20);
    const showAll = renderer.root.find(
      (node) => node.type === "button" && String(node.children[0]).startsWith("Show all"),
    );
    await press(showAll);
    expect(rows()).toBe(25);
  });

  it("never calls the server from a connection without the settings scope", async () => {
    state.canWrite = false;
    mount();
    expect(button("data-storage-cleanup-check").props.disabled).toBe(true);
    // Even if the disabled button is pressed, the hook refuses before any request.
    await press(button("data-storage-cleanup-check"));
    expect(state.getPlan).not.toHaveBeenCalled();
    expect(text()).toContain("This connection cannot change this machine's storage.");
  });

  it("does not run Clean up now once the connection lost the settings scope", async () => {
    mount();
    await press(button("data-storage-cleanup-check"));
    state.canWrite = false;
    await press(button("data-storage-cleanup-run"));
    expect(state.runCleanup).not.toHaveBeenCalled();
    expect(text()).toContain("This connection cannot change this machine's storage.");
  });

  it("shows nothing for a machine whose server cannot answer the plan", () => {
    state.capable = false;
    mount();
    expect(renderer.toJSON()).toBeNull();
  });
});
