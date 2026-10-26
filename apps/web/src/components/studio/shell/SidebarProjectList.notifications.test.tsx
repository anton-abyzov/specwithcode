// @vitest-environment jsdom
import { DndContext } from "@dnd-kit/core";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import type { ProjectNotificationLevel } from "@specweave-studio/shared/projectNotifications";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../../sidebarProjectGrouping";
import {
  membersToNotify,
  notificationsWorkspacePatch,
} from "../../../studio/projectListVisibility";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useRouter: () => ({ routesById: {} }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./Tip", () => ({ Tip: ({ children }: React.PropsWithChildren) => children }));

const { ProjectRow } = await import("./SidebarProjectList");

const host = EnvironmentId.make("host");
const remote = EnvironmentId.make("remote");
const member = (environmentId: EnvironmentId, id: string, notifications?: string) =>
  ({
    environmentId,
    id: ProjectId.make(id),
    workspaceRoot: `/work/${id}`,
    workspaceSettings: { revision: 4, ...(notifications ? { notifications } : {}) },
  }) as unknown as SidebarProjectGroupMember;
const group = {
  projectKey: "atlas",
  displayName: "Atlas",
  workspaceRoot: "/work/atlas",
  memberProjects: [member(host, "near")],
} as unknown as SidebarProjectSnapshot;

describe("project notification level patches", () => {
  it("changes every machine's copy that differs, never the scratch folder", () => {
    const members = [member(host, "near"), member(remote, "far", "none"), member(host, "scratch")];
    const scratchRootFor = (environmentId: EnvironmentId) =>
      environmentId === host ? "/work/scratch" : null;
    expect(
      membersToNotify({ memberProjects: members }, "none", scratchRootFor).map((m) => m.id),
    ).toEqual(["near"]);
    expect(
      membersToNotify({ memberProjects: members }, "coordinator", scratchRootFor).map((m) => m.id),
    ).toEqual(["far"]);
    expect(notificationsWorkspacePatch(members[0]!, "requests")).toEqual({
      expectedRevision: 4,
      notifications: "requests",
    });
  });
});

describe("ProjectRow Notifications item", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onChange = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onChange.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderRow(level: ProjectNotificationLevel, waiting = 0) {
    await act(async () =>
      root.render(
        <DndContext>
          <ul>
            <ProjectRow
              group={group}
              displayedProject={undefined}
              archived={false}
              waiting={waiting}
              current={false}
              onOpen={() => {}}
              onArchive={() => {}}
              notifications={level}
              onNotificationsChange={onChange}
            />
          </ul>
        </DndContext>,
      ),
    );
  }
  async function openMenu() {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Actions for Atlas"]')!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.click();
    });
  }
  const notificationsItem = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.startsWith("Notifications"),
    );

  it("shows the current level and saves another one", async () => {
    await renderRow("coordinator");
    await openMenu();
    const item = notificationsItem();
    expect(item?.textContent).toBe("NotificationsCoordinator");
    await act(async () => {
      item!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      item!.click();
    });
    const options = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    expect(options.map((option) => option.textContent)).toEqual([
      "All new messagesIncludes replies in every thread",
      "Coordinator and requestsThe main chat and anything waiting on you",
      "Only requestsApprovals, questions, plans and sign-ins",
      "NothingNo alerts and no waiting count",
    ]);
    expect(options[1]?.getAttribute("aria-checked")).toBe("true");
    await act(async () => options[3]!.click());
    expect(onChange).toHaveBeenCalledWith("none");
  });

  it("hides the waiting count and shows a muted bell when set to nothing", async () => {
    await renderRow("requests", 2);
    expect(container.querySelector(".sws-count-waiting")?.textContent).toContain("2");
    expect(container.querySelector('[aria-label="Notifications off"]')).toBeNull();
    await renderRow("none", 2);
    expect(container.querySelector(".sws-count-waiting")).toBeNull();
    expect(container.querySelector('[aria-label="Notifications off"]')).not.toBeNull();
  });
});
