// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => state.navigate,
  Link: ({
    to,
    params,
    onClick,
    ...rest
  }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    params: Record<string, string>;
  }) => (
    <a
      {...rest}
      href={`/${params.environmentId}/${params.threadId}`}
      data-to={to}
      onClick={(event) => {
        onClick?.(event);
        // The router's own link navigates unless an earlier handler took the click.
        if (!event.defaultPrevented) {
          event.preventDefault();
          state.navigate({ to, params });
        }
      }}
    />
  ),
}));
vi.mock("~/state/entities", () => ({ useThreadShell: () => ({ title: "Worker thread" }) }));

import type { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import {
  ProjectMessageRoutingContext,
  type ProjectMessageRouting,
} from "../studio/projectMessageRouting";
import { ThreadContextChip } from "./ThreadContextChip";

let root: Root, container: HTMLDivElement;
const record = {
  environmentId: "host" as EnvironmentId,
  threadId: "worker" as ThreadId,
  title: "Old title",
};
async function render(routing: ProjectMessageRouting | null) {
  await act(async () =>
    root.render(
      <ProjectMessageRoutingContext value={routing}>
        <ThreadContextChip record={record} />
      </ProjectMessageRoutingContext>,
    ),
  );
  return container.querySelector<HTMLAnchorElement>("a")!;
}
const routing = (openThread: ProjectMessageRouting["openThread"]): ProjectMessageRouting => ({
  coordinatorThreadId: null,
  send: vi.fn(async () => undefined),
  openCoordinator: vi.fn(),
  openThread,
});

beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.navigate.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("ThreadContextChip", () => {
  it("opens the thread in the project's right panel when it is inside a project", async () => {
    const openThread = vi.fn(() => true);
    const link = await render(routing(openThread));
    expect(link.textContent).toContain("Worker thread");
    await act(async () => link.click());
    expect(openThread).toHaveBeenCalledWith("worker", "host");
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("follows its link when the project does not take the thread, or outside a project", async () => {
    let link = await render(routing(() => false));
    await act(async () => link.click());
    expect(state.navigate).toHaveBeenCalledTimes(1);
    link = await render(null);
    await act(async () => link.click());
    expect(state.navigate).toHaveBeenCalledTimes(2);
  });
  it("leaves a modified click to the link", async () => {
    const openThread = vi.fn(() => true);
    const link = await render(routing(openThread));
    await act(async () =>
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true })),
    );
    expect(openThread).not.toHaveBeenCalled();
  });
});
