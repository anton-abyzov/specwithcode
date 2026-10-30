// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  navigate: vi.fn(),
  bootstrapped: true,
  shells: [] as Array<{
    id: string;
    environmentId: string;
    title: string;
    deletedAt: string | null;
    runtime: null;
    latestRun: null;
  }>,
}));
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
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) {
          event.preventDefault();
          state.navigate({ to, params });
        }
      }}
    />
  ),
}));
vi.mock("~/state/entities", () => ({
  useThreadShells: () => state.shells,
  useAllEnvironmentShellsBootstrapped: () => state.bootstrapped,
  useThreadShell: ({ threadId }: { threadId: string }) =>
    state.shells.find((shell) => shell.id === threadId) ?? null,
}));

import type { EnvironmentId } from "@specweave-studio/contracts";
import {
  ProjectMessageRoutingContext,
  type ProjectMessageRouting,
} from "../studio/projectMessageRouting";
import {
  looksLikeEnvironmentId,
  parseStudioThreadHref,
  parseStudioThreadTarget,
} from "../studio/studioThreadLinks";
import { StudioThreadLink } from "./StudioThreadLink";

let root: Root, container: HTMLDivElement;
const DELEGATED = "thread:delegated-task:command%3Amcp%3Aa1%3Adelegate-task%3Afix-login";
async function render(
  href: string,
  routing: ProjectMessageRouting | null = null,
  environmentId: EnvironmentId | null = "host" as EnvironmentId,
  label = "Worker",
) {
  await act(async () =>
    root.render(
      <ProjectMessageRoutingContext value={routing}>
        <StudioThreadLink
          environmentId={environmentId}
          candidates={parseStudioThreadHref(href)!}
          label={label}
        />
      </ProjectMessageRoutingContext>,
    ),
  );
}
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.navigate.mockReset();
  state.bootstrapped = true;
  const shell = (id: string, title: string, deletedAt: string | null = null) => ({
    id,
    environmentId: "host",
    title,
    deletedAt,
    runtime: null,
    latestRun: null,
  });
  state.shells = [
    shell("thread:mcp:a:b:0", "Fix the login"),
    shell(DELEGATED, "Delegated worker"),
    shell("gone", "Gone", "2026-10-11T00:00:00Z"),
    shell("first-try", "Retry me", "2026-10-11T00:00:00Z"),
    shell("second-try", "Retry me"),
  ];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("StudioThreadLink", () => {
  const routing = (openThread: ProjectMessageRouting["openThread"]) => ({
    coordinatorThreadId: null,
    send: vi.fn(async () => undefined),
    openCoordinator: vi.fn(),
    openThread,
  });
  it("opens a coordinator's worker link in the project's right panel", async () => {
    const openThread = vi.fn(() => true);
    await render("studio://thread/thread%3Amcp%3Aa%3Ab%3A0", routing(openThread));
    await act(async () => container.querySelector("a")!.click());
    expect(openThread).toHaveBeenCalledWith("thread:mcp:a:b:0", "host");
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it.each([
    ["the raw ID", `studio://thread/${DELEGATED}`],
    ["the canonical encoded ID", `studio://thread/${encodeURIComponent(DELEGATED)}`],
  ])("opens a delegated worker named by %s", async (_name, href) => {
    const openThread = vi.fn(() => true);
    await render(href, routing(openThread));
    const chip = container.querySelector("a")!;
    expect(chip.className).toContain("sws-thread-link");
    expect(chip.getAttribute("aria-label")).toMatch(/^Open thread Delegated worker, \w+/);
    expect(chip.querySelector(".sws-dot")).not.toBeNull();
    expect(chip.getAttribute("data-markdown-copy")).toBe(
      `[Delegated worker](studio://thread/${encodeURIComponent(DELEGATED)})`,
    );
    await act(async () => chip.click());
    expect(openThread).toHaveBeenCalledWith(DELEGATED, "host");
  });
  it("opens it full page outside a project, also when the link names the title", async () => {
    await render("studio://thread/Fix%20the%20login");
    await act(async () => container.querySelector("a")!.click());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "thread:mcp:a:b:0" },
    });
  });
  it("says a link names a thread this machine does not have", async () => {
    await render("studio://thread/missing");
    expect(container.querySelector("a")).toBeNull();
    const chip = container.querySelector('[role="link"]')!;
    expect(chip.getAttribute("aria-disabled")).toBe("true");
    expect(chip.getAttribute("aria-label")).toBe("Worker, Thread not found on this machine");
    expect(chip.textContent).toBe("Worker");
  });
  it("says a link names a deleted thread", async () => {
    await render("studio://thread/gone");
    const chip = container.querySelector('[role="link"]')!;
    expect(chip.getAttribute("data-thread-link-dead")).toBe("deleted");
    expect(chip.getAttribute("aria-label")).toBe("Worker, Thread was deleted");
  });
  it("says a deleted thread is deleted, not the live retry that shares its title", async () => {
    await render("studio://thread/first-try", null, "host" as EnvironmentId, "Retry me");
    expect(container.querySelector("a")).toBeNull();
    const chip = container.querySelector('[role="link"]')!;
    expect(chip.getAttribute("data-thread-link-dead")).toBe("deleted");
  });
  it("reads as its label before this machine's threads have loaded", async () => {
    state.bootstrapped = false;
    await render("studio://thread/missing");
    expect(container.querySelector('[role="link"]')).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("Worker");
  });
  it("opens a worker on another machine this browser is connected to, keeping its machine", async () => {
    state.shells.push({
      id: "b-thread",
      environmentId: "env-m1",
      title: "Fix CI",
      deletedAt: null,
      runtime: null,
      latestRun: null,
    });
    const target = parseStudioThreadTarget("studio://thread/env-m1/b-thread")!;
    await act(async () =>
      root.render(
        <StudioThreadLink
          environmentId={target.environmentId as EnvironmentId}
          candidates={target.candidates}
          label="Fix CI"
          linkedEnvironment
        />,
      ),
    );
    const chip = container.querySelector("a")!;
    expect(chip.getAttribute("data-markdown-copy")).toBe(
      "[Fix CI](studio://thread/env-m1/b-thread)",
    );
    await act(async () => chip.click());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-m1", threadId: "b-thread" },
    });
  });
  it("opens a bare link naming a thread on a connected peer machine", async () => {
    state.shells.push({
      id: "peer-thread",
      environmentId: "env-m1",
      title: "Ministorm proof run",
      deletedAt: null,
      runtime: null,
      latestRun: null,
    });
    // The coordinator's message is scoped to "host"; the worker lives on env-m1.
    await render(
      "studio://thread/peer-thread",
      null,
      "host" as EnvironmentId,
      "Ministorm proof run",
    );
    const chip = container.querySelector("a")!;
    expect(chip.getAttribute("data-thread-link-dead")).toBeNull();
    expect(chip.getAttribute("data-markdown-copy")).toBe(
      "[Ministorm proof run](studio://thread/env-m1/peer-thread)",
    );
    await act(async () => chip.click());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-m1", threadId: "peer-thread" },
    });
  });
  it("opens a bare title link naming a thread only a connected peer machine has", async () => {
    state.shells.push({
      id: "peer-thread",
      environmentId: "env-m1",
      title: "Ministorm proof run",
      deletedAt: null,
      runtime: null,
      latestRun: null,
    });
    await render(
      "studio://thread/Ministorm%20proof%20run",
      null,
      "host" as EnvironmentId,
      "Ministorm proof run",
    );
    await act(async () => container.querySelector("a")!.click());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env-m1", threadId: "peer-thread" },
    });
  });
  it("keeps a bare link to a deleted peer thread dead", async () => {
    state.shells.push({
      id: "peer-gone",
      environmentId: "env-m1",
      title: "Peer gone",
      deletedAt: "2026-10-11T00:00:00Z",
      runtime: null,
      latestRun: null,
    });
    await render("studio://thread/peer-gone", null, "host" as EnvironmentId, "Peer gone");
    expect(container.querySelector("a")).toBeNull();
    const chip = container.querySelector('[role="link"]')!;
    expect(chip.getAttribute("data-thread-link-dead")).toBe("deleted");
  });
  it("says a worker is on a machine this browser is not connected to", async () => {
    const target = parseStudioThreadTarget(
      "studio://thread/5b0c3c1e-8d4f-4a52-9f3e-2b7d6c1a9e40/b-thread",
    )!;
    await act(async () =>
      root.render(
        <StudioThreadLink
          environmentId={target.environmentId as EnvironmentId}
          candidates={target.candidates}
          label="Fix CI"
          linkedEnvironment
        />,
      ),
    );
    const chip = container.querySelector('[role="link"]')!;
    expect(chip.getAttribute("data-thread-link-dead")).toBe("elsewhere");
    expect(chip.getAttribute("aria-label")).toContain("Thread on another machine");
  });
  it("reads only a server UUID before the thread as another machine", () => {
    expect(looksLikeEnvironmentId("5b0c3c1e-8d4f-4a52-9f3e-2b7d6c1a9e40")).toBe(true);
    expect(looksLikeEnvironmentId("CI")).toBe(false);
  });
  it("reads as its label without an environment", async () => {
    await render("studio://thread/thread%3Amcp%3Aa%3Ab%3A0", null, null);
    expect(container.querySelector('[role="link"]')).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toBe("Worker");
  });
});
