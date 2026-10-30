// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentProject } from "@specweave-studio/client-runtime/state/shell";
import { ProjectExecutionHistory, ProjectThreadAvailability } from "./ProjectExecutionHistory";
import type { ProjectExecutionScope } from "../../studio/projectDomain";

const state = vi.hoisted(() => ({
  load: vi.fn(),
  projection: vi.fn(),
  history: { hasMoreHistory: true, loading: false, error: null as string | null },
  historyListeners: new Set<() => void>(),
  missingHistory: false,
  olderLoaded: false,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: (id: string) =>
    id === "m3" ? null : { label: id.toUpperCase(), connection: { phase: "connected" } },
  useEnvironments: () => ({
    environments: [{ environmentId: "m4", label: "M4", connection: { phase: "connected" } }],
  }),
}));
vi.mock("../../state/entities", async () => {
  const { useSyncExternalStore } = await import("react");
  // Subscribes like the real atom does: the history changes without a parent re-render.
  const subscribe = (listener: () => void) => {
    state.historyListeners.add(listener);
    return () => state.historyListeners.delete(listener);
  };
  return {
    useThreadProjection: (ref: unknown) => state.projection(ref),
    useThreadHistory: () => useSyncExternalStore(subscribe, () => state.history),
    useServerConfigs: () => new Map(),
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.load }));
vi.mock("../../state/threads", () => ({ threadEnvironment: { loadEarlierHistory: {} } }));
const scopes = ["m4", "m1", "m3"].map((environmentId) => ({
  environmentId,
  projectId: "project",
  coordinatorThreadId: "same-coordinator-id",
})) as ProjectExecutionScope[];
const member = (environmentId: string) => ({
  environmentId,
  projectId: "project",
  coordinatorThreadId: "same-coordinator-id",
});
// The coordinator moved M3 -> M1 -> M4: each handoff names the machine it came from.
const project = {
  id: "project",
  environmentId: "m4",
  workspaceSettings: {
    logicalProject: { id: "one" },
    coordinatorBinding: { epoch: 2, state: "active", predecessor: member("m1") },
  },
} as unknown as EnvironmentProject;
const m1 = {
  id: "project",
  environmentId: "m1",
  workspaceSettings: {
    logicalProject: { id: "one" },
    coordinatorBinding: {
      epoch: 1,
      state: "transferred",
      predecessor: member("m3"),
      successor: member("m4"),
    },
  },
} as unknown as EnvironmentProject;
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  state.history = { hasMoreHistory: true, loading: false, error: null };
  state.missingHistory = false;
  state.olderLoaded = false;
  state.load.mockResolvedValue(undefined);
  state.projection.mockImplementation(() =>
    state.missingHistory
      ? null
      : {
          projection: {
            messages: [
              ...(state.olderLoaded
                ? [{ id: "older", role: "user", text: "Earlier retained request", runId: null }]
                : []),
              { id: "request", role: "user", text: "Original request on M1", runId: "old-run" },
              {
                id: "reply",
                role: "assistant",
                text: "Original coordinator reply",
                runId: "old-run",
              },
            ],
            runs: [
              {
                id: "old-run",
                modelSelection: { instanceId: "claude-native", model: "recorded-old-model" },
              },
            ],
          },
        },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = () =>
  act(async () =>
    root.render(<ProjectExecutionHistory project={project} members={[m1]} scopes={scopes} />),
  );
const setHistory = (history: typeof state.history) =>
  act(async () => {
    state.history = history;
    for (const listener of state.historyListeners) listener();
  });
async function expand(label: string) {
  const details = [...container.querySelectorAll("details")].find((entry) =>
    entry.querySelector("summary")?.textContent?.includes(label),
  )!;
  expect(details).toBeDefined();
  await act(async () => {
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  });
}

it("loads the selected predecessor lazily with its exact machine scope and recorded model", async () => {
  await render();
  expect(state.projection).not.toHaveBeenCalled();
  expect(container.textContent).not.toContain("Previous coordinator on M4");
  await expand("Previous coordinator on M1");
  expect(state.projection).toHaveBeenCalledWith({
    environmentId: "m1",
    threadId: "same-coordinator-id",
  });
  expect(
    container.querySelector('[aria-label="Retained coordinator messages on M1"]')?.textContent,
  ).toContain("Original request on M1");
  expect([...container.querySelectorAll("article h3")].map((node) => node.textContent)).toEqual([
    "You",
    "Coordinator",
  ]);
  expect(container.textContent).toContain("M1 · Claude Code · Recorded Old Model");
  expect(container.querySelector("textarea")).toBeNull();
});

it("pages predecessor messages on their original host, blocks duplicate loading, and exposes paging failure without hiding retained history", async () => {
  await render();
  await expand("Previous coordinator on M1");
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(state.load).toHaveBeenCalledWith({
    environmentId: "m1",
    input: { threadId: "same-coordinator-id" },
  });
  await setHistory({ hasMoreHistory: true, loading: true, error: null });
  expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  expect(state.load).toHaveBeenCalledTimes(1);
  await setHistory({ hasMoreHistory: true, loading: false, error: "M1 history request failed" });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("M1 history request failed");
  expect(container.textContent).toContain("Original coordinator reply");
  state.olderLoaded = true;
  await setHistory({ hasMoreHistory: false, loading: false, error: null });
  expect(container.textContent).toContain("Earlier retained request");
  expect(container.textContent).toContain("M1 · Model not recorded");
  expect(container.querySelector("button")).toBeNull();
});

it("names an unavailable predecessor without presenting missing history as an empty transcript", async () => {
  state.missingHistory = true;
  await render();
  await expand("Previous coordinator on m3");
  expect(container.textContent).toContain("Previous coordinator on m3 · Read only · Offline");
  expect(container.textContent).toContain(
    "History is unavailable. Connect m3 to load its retained messages.",
  );
  expect(state.projection).toHaveBeenCalledWith({
    environmentId: "m3",
    threadId: "same-coordinator-id",
  });
  expect(state.load).not.toHaveBeenCalled();
  await act(async () =>
    root.render(<ProjectThreadAvailability scopes={[scopes[0]!, scopes[2]!, scopes[2]!]} />),
  );
  expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
  expect(container.textContent).toContain(
    "This app is not connected to m3 — the thread list may be incomplete",
  );
});

it("does not invent handoff history for an unlinked legacy project", async () => {
  await act(async () =>
    root.render(
      <ProjectExecutionHistory
        project={{ ...project, workspaceSettings: undefined }}
        members={[]}
        scopes={scopes}
      />,
    ),
  );
  expect(container.textContent).toBe("");
  expect(state.projection).not.toHaveBeenCalled();
});

it("stays hidden for a linked project until it has handoff history", async () => {
  await act(async () =>
    root.render(
      <ProjectExecutionHistory
        project={project}
        members={[]}
        scopes={[scopes[0]!, { ...scopes[1]!, coordinatorThreadId: null }]}
      />,
    ),
  );
  expect(container.textContent).toBe("");
});

it("shows no handoff history beside a linked copy whose coordinator never moved", async () => {
  // A link or "Copy files only" adds a member that relinquished its own coordinator; this one stays.
  const kept = {
    ...project,
    workspaceSettings: {
      logicalProject: { id: "one" },
      coordinatorBinding: { epoch: 0, state: "active" },
    },
  } as unknown as EnvironmentProject;
  const copy = {
    id: "project",
    environmentId: "m3",
    workspaceSettings: {
      logicalProject: { id: "one" },
      coordinatorBinding: { epoch: 0, state: "transferred", successor: member("m4") },
    },
  } as unknown as EnvironmentProject;
  for (const members of [[copy], []])
    await act(async () =>
      root.render(
        <ProjectExecutionHistory
          project={kept}
          members={members}
          scopes={[scopes[0]!, scopes[2]!]}
        />,
      ),
    );
  expect(container.textContent).toBe("");
  // On the copy itself, the coordinator still runs beside it on M4, not before it.
  await act(async () =>
    root.render(
      <ProjectExecutionHistory project={copy} members={[kept]} scopes={[scopes[0]!, scopes[2]!]} />,
    ),
  );
  expect(container.textContent).toBe("");
});

it("renders the banner as its own slot, so the coordinator page gives it a row of its own", async () => {
  await render();
  const banner = container.querySelector('[aria-label="Coordinator handoff history"]');
  expect(banner?.getAttribute("data-slot")).toBe("handoff-history");
  expect(banner?.textContent).toContain("Continued from another machine.");
});
