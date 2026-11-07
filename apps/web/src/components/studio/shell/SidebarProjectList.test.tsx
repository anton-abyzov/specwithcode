// @vitest-environment jsdom
import { DndContext } from "@dnd-kit/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useRouter: () => ({ routesById: {} }),
  useNavigate: () => () => undefined,
}));
vi.mock("../../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./Tip", () => ({ Tip: ({ children }: React.PropsWithChildren) => children }));
vi.mock("../../../studio/machineNickname", () => ({
  useMachineNicknames: () => (id: string) => ({ m4: "M4 Max", m1: "Ministorm" })[id] ?? id,
}));

const { ProjectRow } = await import("./SidebarProjectList");

const member = (environmentId: string, projectId: string) => ({
  environmentId,
  projectId,
  workspaceRoot: `/work/${environmentId}`,
});
const copy = (environmentId: string, coordinator: string) => ({
  environmentId,
  id: `p-${environmentId}`,
  title: "EasyChamp",
  workspaceRoot: `/work/${environmentId}`,
  workspaceSettings: {
    logicalProject: {
      id: "logical:1",
      title: "EasyChamp",
      members: [member("m4", "p-m4"), member("m1", "p-m1")],
    },
    // A copy that handed its coordinator off names where it went.
    coordinatorBinding:
      environmentId === coordinator
        ? { state: "active", epoch: 1 }
        : {
            state: "transferred",
            epoch: 1,
            successor: { environmentId: coordinator, projectId: `p-${coordinator}` },
          },
  },
});

describe("ProjectRow shared badge", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(displayed: ReturnType<typeof copy>) {
    const members = [copy("m4", "m4"), copy("m1", "m4")];
    const group = {
      projectKey: "logical-project:logical:1",
      displayName: "EasyChamp",
      workspaceRoot: displayed.workspaceRoot,
      memberProjects: members,
    } as unknown as SidebarProjectSnapshot;
    await act(async () =>
      root.render(
        <DndContext>
          <ul>
            <ProjectRow
              group={group}
              displayedProject={displayed as never}
              archived={false}
              waiting={0}
              current={false}
              onOpen={() => {}}
              onArchive={() => {}}
            />
          </ul>
        </DndContext>,
      ),
    );
    return container.querySelector<HTMLElement>("[data-shared-project]");
  }

  it("shows the shared label as a hover tooltip on the coordinator's copy", async () => {
    const badge = await render(copy("m4", "m4"));
    expect(badge?.dataset.sharedProject).toBe("coordinator");
    expect(badge?.getAttribute("aria-label")).toBe("Shared from M4 Max with Ministorm");
    expect(badge?.getAttribute("title")).toBe(badge?.getAttribute("aria-label"));
    expect(badge?.getAttribute("role")).toBe("img");
    expect(badge?.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows the handed-off label as a hover tooltip on a workers' copy", async () => {
    const badge = await render(copy("m1", "m4"));
    expect(badge?.dataset.sharedProject).toBe("workers");
    expect(badge?.getAttribute("title")).toBe(
      "Handed off: coordinator on M4 Max, Ministorm runs workers",
    );
    expect(badge?.getAttribute("aria-label")).toBe(badge?.getAttribute("title"));
  });
});
