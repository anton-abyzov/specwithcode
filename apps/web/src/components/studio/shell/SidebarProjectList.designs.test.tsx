// @vitest-environment jsdom
import { DndContext } from "@dnd-kit/core";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useRouter: () => ({ routesById: {} }),
  useNavigate: () => navigate,
}));
vi.mock("../../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./Tip", () => ({ Tip: ({ children }: React.PropsWithChildren) => children }));

const { ProjectRow, designsProjectId } = await import("./SidebarProjectList");

const host = EnvironmentId.make("host");
const remote = EnvironmentId.make("remote");
const member = (environmentId: EnvironmentId, id: string, workspaceRoot = `/work/${id}`) =>
  ({ environmentId, id: ProjectId.make(id), workspaceRoot }) as SidebarProjectGroupMember;
const groupOf = (...members: SidebarProjectGroupMember[]) =>
  ({
    projectKey: "atlas",
    displayName: "Atlas",
    workspaceRoot: "/work/atlas",
    memberProjects: members,
  }) as unknown as SidebarProjectSnapshot;
const noScratch = () => null;

describe("designsProjectId", () => {
  it("picks the checkout on the primary environment", () => {
    const group = groupOf(member(remote, "far"), member(host, "near"));
    expect(designsProjectId(group, undefined, host, noScratch)).toBe("near");
  });

  it("prefers the displayed checkout when the primary environment has several", () => {
    const shown = member(host, "second");
    const group = groupOf(member(host, "first"), shown);
    expect(designsProjectId(group, shown, host, noScratch)).toBe("second");
  });

  it("has none for a remote-only project or without a primary environment", () => {
    const group = groupOf(member(remote, "far"));
    expect(designsProjectId(group, undefined, host, noScratch)).toBeUndefined();
    expect(designsProjectId(groupOf(member(host, "near")), undefined, null, noScratch)).toBe(
      undefined,
    );
  });

  it("has none for the scratch project", () => {
    const group = groupOf(member(host, "scratch", "/home/user/scratch"));
    const scratchRootFor = (environmentId: EnvironmentId) =>
      environmentId === host ? "/home/user/scratch" : null;
    expect(designsProjectId(group, undefined, host, scratchRootFor)).toBeUndefined();
  });
});

describe("ProjectRow Designs item", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onOpen = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    navigate.mockClear();
    onOpen.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function openMenu(designs: ProjectId | undefined) {
    await act(async () =>
      root.render(
        <DndContext>
          <ul>
            <ProjectRow
              group={groupOf(member(host, "near"))}
              displayedProject={undefined}
              archived={false}
              waiting={0}
              current={false}
              onOpen={onOpen}
              onArchive={() => {}}
              designsProjectId={designs}
            />
          </ul>
        </DndContext>,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Atlas"]')!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.click();
    });
  }
  const designsItem = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === "Designs",
    );

  it("opens the project's designs in the gallery", async () => {
    await openMenu(ProjectId.make("near"));
    await act(async () => designsItem()!.click());
    expect(navigate).toHaveBeenCalledWith({ to: "/design", search: { project: "near" } });
    expect(onOpen).toHaveBeenCalled();
  });

  it("leaves the item out when the project has no designs to show", async () => {
    await openMenu(undefined);
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
    expect(designsItem()).toBeUndefined();
  });
});
