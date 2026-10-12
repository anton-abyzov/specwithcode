import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

import {
  ProjectMessageRoutingContext,
  type ProjectMessageRouting,
} from "../studio/projectMessageRouting";
import { openThreadInProject, useOpenThread } from "./useOpenThread";

const ref = (threadId: string, environmentId = "host") => ({
  environmentId: environmentId as EnvironmentId,
  threadId: threadId as ThreadId,
});

function routing(openThread: ProjectMessageRouting["openThread"]): ProjectMessageRouting {
  return {
    coordinatorThreadId: null,
    send: vi.fn(async () => undefined),
    openCoordinator: vi.fn(),
    openThread,
  };
}

let renderer: ReactTestRenderer | null = null;
const openers: Array<ReturnType<typeof useOpenThread>> = [];
function Probe() {
  openers.push(useOpenThread());
  return null;
}
async function render(value: ProjectMessageRouting | null) {
  await act(() => {
    renderer = create(
      <ProjectMessageRoutingContext value={value}>
        <Probe />
      </ProjectMessageRoutingContext>,
    );
  });
  return openers.at(-1)!;
}

beforeEach(() => {
  navigate.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  openers.length = 0;
  vi.unstubAllGlobals();
});

describe("openThreadInProject", () => {
  it("is false outside a project", () => {
    expect(openThreadInProject(null, ref("t1"))).toBe(false);
  });
  it("passes the thread and its environment to the project", () => {
    const openThread = vi.fn(() => true);
    expect(openThreadInProject({ openThread }, ref("t1", "other"))).toBe(true);
    expect(openThread).toHaveBeenCalledWith("t1", "other");
  });
});

describe("useOpenThread", () => {
  it("navigates full page outside a project", async () => {
    const { openThread } = await render(null);
    await openThread(ref("t1"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "t1" },
    });
  });
  it("keeps the thread in the project's panel when the project takes it", async () => {
    const take = vi.fn(() => true);
    const { openThread, openInProject } = await render(routing(take));
    await openThread(ref("t1"));
    expect(take).toHaveBeenCalledWith("t1", "host");
    expect(navigate).not.toHaveBeenCalled();
    expect(openInProject(ref("t2"))).toBe(true);
  });
  it("falls back to the full page for a thread the project does not own", async () => {
    const { openThread } = await render(routing(() => false));
    await openThread(ref("t1"), { replace: true });
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "t1" },
      replace: true,
    });
  });
  it("keeps one identity while the project's routing changes, and reads the current one", async () => {
    const first = await render(routing(() => false));
    const take = vi.fn(() => true);
    await act(() => {
      renderer!.update(
        <ProjectMessageRoutingContext value={routing(take)}>
          <Probe />
        </ProjectMessageRoutingContext>,
      );
    });
    const second = openers.at(-1)!;
    expect(second.openThread).toBe(first.openThread);
    expect(second.openInProject).toBe(first.openInProject);
    await first.openThread(ref("t1"));
    expect(take).toHaveBeenCalledWith("t1", "host");
    expect(navigate).not.toHaveBeenCalled();
  });
});
