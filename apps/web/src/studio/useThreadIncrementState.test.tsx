// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import type { ThreadIncrementState } from "./useThreadIncrementProgress";

const session = vi.hoisted(() => ({
  canRead: true,
  access: "granted" as "granted" | "denied" | "signed-out" | "unknown",
  data: null as null | { threads: unknown[]; unplanned: string[] },
}));

vi.mock("../state/session", () => ({
  useEnvironmentScope: () => session.canRead,
  useEnvironmentScopeAccess: () => session.access,
}));
vi.mock("../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === null ? null : session.data,
    isPending: false,
    refresh: () => {},
  }),
}));
vi.mock("./projectWorkspace", () => ({
  projectWorkspace: { threadIncrementProgress: (input: unknown) => ({ input }) },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => 0 }));

const { useThreadIncrementState } = await import("./useThreadIncrementProgress");

async function states(
  steps: ReadonlyArray<Partial<typeof session>>,
): Promise<ThreadIncrementState[]> {
  const seen: ThreadIncrementState[] = [];
  function Probe() {
    seen.push(
      useThreadIncrementState({
        environmentId: "host" as never,
        projectId: "project" as never,
        threadIds: ["worker"] as never,
      }),
    );
    return null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  for (const step of steps) {
    Object.assign(session, step);
    await act(async () => root.render(createElement(Probe)));
  }
  await act(async () => root.unmount());
  return seen;
}

it("does not answer an empty read while the session cannot say whether it may read", async () => {
  const seen = await states([
    { canRead: true, access: "granted", data: { threads: [], unplanned: ["worker"] } },
    // A failed or timed-out session refresh withholds the scope without denying it.
    { canRead: false, access: "unknown" },
  ]);
  expect(seen.at(-1)).toMatchObject({ answered: false, unplanned: new Set() });
});

it("answers an empty read once access is denied", async () => {
  const seen = await states([
    { canRead: true, access: "granted", data: { threads: [], unplanned: ["worker"] } },
    { canRead: false, access: "denied" },
  ]);
  expect(seen.at(-1)).toMatchObject({ answered: true, unplanned: new Set() });
});
