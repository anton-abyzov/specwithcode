// @vitest-environment jsdom
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
const host = EnvironmentId.make("host");
vi.mock("../../../state/entities", () => ({
  useServerConfigs: () => new Map([[host, { scratchWorkspaceRoot: "/home/user/scratch" }]]),
}));
vi.mock("../../../lib/projectWindow", () => ({
  canOpenProjectWindowFor: () => true,
  openProjectWindow: vi.fn(async () => undefined),
}));

const { ProjectMoreMenu } = await import("./ProjectMoreMenu");

describe("ProjectMoreMenu", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onOpenPlan = vi.fn();
  const onOpenSettingsTab = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    navigate.mockClear();
    onOpenPlan.mockClear();
    onOpenSettingsTab.mockClear();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  async function openMenu(workspaceRoot: string, designHere?: boolean) {
    await act(async () =>
      root.render(
        <ProjectMoreMenu
          project={{ environmentId: host, id: ProjectId.make("atlas-web"), workspaceRoot }}
          projectKey="logical-project:atlas"
          projectTitle="Atlas web"
          onOpenPlan={onOpenPlan}
          onOpenSettingsTab={onOpenSettingsTab}
          {...(designHere === undefined ? {} : { designHere })}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label="More project actions"]',
    )!;
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.click();
    });
  }
  const items = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((item) =>
      item.textContent?.trim(),
    );
  const item = (label: string) =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (entry) => entry.textContent?.trim() === label,
    )!;

  it("opens the project's design board from Design", async () => {
    await openMenu("/work/atlas-web");
    expect(items()).toEqual(["Plan", "Design", "Usage", "Routines", "Open in new window"]);
    await act(async () => item("Design").click());
    expect(navigate).toHaveBeenCalledWith({ to: "/design", search: { project: "atlas-web" } });
  });

  it("keeps Plan, Usage and Routines wired", async () => {
    await openMenu("/work/atlas-web");
    await act(async () => item("Plan").click());
    expect(onOpenPlan).toHaveBeenCalled();
    await openMenu("/work/atlas-web");
    await act(async () => item("Routines").click());
    expect(onOpenSettingsTab).toHaveBeenCalledWith("routines");
  });

  it("has no Design item for a machine's No project folder", async () => {
    await openMenu("/home/user/scratch");
    expect(items()).toEqual(["Plan", "Usage", "Routines", "Open in new window"]);
  });

  it("has no Design item for a project running on another machine", async () => {
    await openMenu("/Users/me/atlas-web", false);
    expect(items()).toEqual(["Plan", "Usage", "Routines", "Open in new window"]);
  });
});
