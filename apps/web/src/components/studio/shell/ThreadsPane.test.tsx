// @vitest-environment jsdom
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import type { EnvironmentId } from "@specweave-studio/contracts";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));
vi.mock("../../../env", () => ({ isElectron: false }));
vi.mock("../../../state/environments", () => ({
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => "host",
}));
vi.mock("../../../studio/machineNickname", () => ({
  useMachineNicknames: () => (id: string, label?: string | null) => label ?? id,
}));
vi.mock("../../../studio/machineIdentity", () => ({
  useMachineIdentities: () => () => ({ color: "blue" }),
}));
vi.mock("../../../studio/useThreadIncrementProgress", () => ({
  useProjectThreadIncrementProgress: () => ({
    progress: new Map(),
    unplanned: new Set(),
    answered: false,
  }),
}));
vi.mock("../../sidebar/SidebarPlanProgress", () => ({
  useSidebarThreadPlans: () => ({ plans: new Map(), loaders: null }),
}));
vi.mock("../../handoff/HandoffBadge", () => ({
  HandoffRowAction: () => null,
  HandoffRowBadge: () => null,
}));
vi.mock("./ModelBadge", () => ({
  ThreadModelBadge: () => null,
  useProviderEntriesByEnvironment: () => new Map(),
}));

import { toastManager } from "../../ui/toast";
import { ThreadsPane } from "./ThreadsPane";

const thread = (id: string, title: string, pinnedAt: string | null = null) =>
  ({
    id,
    environmentId: "host",
    projectId: "aide",
    title,
    settledOverride: null,
    archivedAt: null,
    pinnedAt,
    pullRequests: [],
    createdBy: "agent",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    runtime: null,
    latestRun: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    deletedAt: null,
    createdAt: "2026-11-10T00:00:00Z",
    updatedAt: "2026-11-11T00:00:00Z",
    modelSelection: { instanceId: "claude", model: "model" },
  }) as unknown as EnvironmentThreadShell;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  onToggleResolved.mockClear();
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const onToggleResolved = vi.fn();
const render = (
  personal: boolean,
  threads: readonly EnvironmentThreadShell[],
  starters = false,
  access: Partial<
    Pick<Parameters<typeof ThreadsPane>[0], "canChangeThread" | "resolveBlockedReason">
  > = {},
) =>
  act(() =>
    root.render(
      <ThreadsPane
        personal={personal}
        environmentId={"host" as EnvironmentId}
        projectId="aide"
        threadsLoaded
        threads={threads}
        canChange
        findRef={createRef<HTMLInputElement>()}
        onOpen={vi.fn()}
        onToggleResolved={onToggleResolved}
        {...access}
        findOpen
        onFindOpenChange={vi.fn()}
        query=""
        onQueryChange={vi.fn()}
        starters={starters ? <p>First ideas</p> : undefined}
        bar={{
          tab: "threads",
          onTabChange: vi.fn(),
          counts: {},
          onNewThread: vi.fn(),
          expanded: false,
          onToggleExpanded: vi.fn(),
          onClose: vi.fn(),
          personal,
        }}
        bulk={{
          running: 1,
          interrupted: 0,
          busy: false,
          onStopAll: vi.fn(),
          onContinueAll: vi.fn(),
        }}
      />,
    ),
  );

// What the pane shows and announces, without the rows' titles, which are the person's words.
const words = (titles: readonly string[]) => {
  const parts = [container.textContent ?? ""];
  for (const node of container.querySelectorAll("[aria-label], [title], [placeholder]"))
    for (const name of ["aria-label", "title", "placeholder"])
      parts.push(node.getAttribute(name) ?? "");
  let text = parts.join("\n");
  for (const title of titles) text = text.split(title).join("");
  return text;
};

describe("the personal assistant's topics pane", () => {
  const threads = [
    thread("taxes", "Taxes 2026", "2026-11-01"),
    thread("errand", "Book a thread lift"),
  ];

  it("says topic everywhere a project's pane says thread", async () => {
    await render(true, threads);
    const aide = words(threads.map(({ title }) => title));
    expect(aide).not.toMatch(/\bthreads?\b|coordinator/i);
    expect(aide).toMatch(/\btopics?\b/i);
    expect(container.querySelector('[aria-label="Topic actions"]')).not.toBeNull();
    expect(container.querySelector('[placeholder="Find a topic"]')).not.toBeNull();

    await render(false, threads);
    const project = words(threads.map(({ title }) => title));
    expect(project).toMatch(/\bthreads?\b/i);
    expect(container.querySelector('[aria-label="Thread actions"]')).not.toBeNull();
  });

  it("leads with pinned topics", async () => {
    await render(true, threads);
    const groups = [...container.querySelectorAll("[data-group]")].map((group) =>
      group.getAttribute("data-group"),
    );
    expect(groups[0]).toBe("Pinned");
  });

  it("invites a first topic while there is none", async () => {
    await render(true, [], true);
    expect(container.textContent).toContain(
      "No topics yet. Ask Percy for a new topic, or pick one below.",
    );
    expect(words([])).not.toMatch(/\bthreads?\b|coordinator/i);
    await render(false, [], true);
    expect(container.textContent).toContain(
      "No threads yet. Pick a first task, or ask the coordinator for one.",
    );
  });
});

describe("a row's Resolve for a thread that runs on another machine", () => {
  const remote = {
    ...thread("remote", "Machine color top line"),
    environmentId: "ministorm",
  } as EnvironmentThreadShell;
  const local = thread("local", "Local work");
  // What the project passes: this machine's own access, false for another machine's thread.
  const canChangeThread = (row: EnvironmentThreadShell) => row.environmentId === "host";
  const action = (id: string) =>
    container.querySelector<HTMLButtonElement>(`[data-thread-id="${id}"] .sws-thread-action`)!;

  it("resolves it when its own machine allows it, whatever this machine's access says", async () => {
    await render(false, [remote, local], false, {
      canChangeThread,
      resolveBlockedReason: () => null,
    });
    const resolve = action("remote");
    expect(resolve.disabled).toBe(false);
    expect(resolve.getAttribute("aria-disabled")).toBeNull();
    await act(async () => resolve.click());
    expect(onToggleResolved).toHaveBeenCalledWith(remote);
  });

  it("says why instead of resolving when its machine is out of reach", async () => {
    const add = vi.spyOn(toastManager, "add");
    const reason = "Ministorm isn't connected right now, so this thread can't be resolved.";
    await render(false, [remote, local], false, {
      canChangeThread,
      resolveBlockedReason: (row) => (row.environmentId === "ministorm" ? reason : null),
    });
    const blocked = action("remote");
    // Not natively disabled: a disabled button shows no tip and takes no click.
    expect(blocked.disabled).toBe(false);
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    await act(async () => blocked.click());
    expect(onToggleResolved).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith({
      type: "warning",
      title: "Can't resolve this thread",
      description: reason,
    });
    await act(async () => action("local").click());
    expect(onToggleResolved).toHaveBeenCalledWith(local);
  });

  it("keeps following this machine's access where no per-thread reason is given", async () => {
    await render(false, [remote, local], false, { canChangeThread });
    expect(action("remote").disabled).toBe(true);
    expect(action("local").disabled).toBe(false);
  });
});
