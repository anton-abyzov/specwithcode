// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

/**
 * The Usage sheet is mounted at the app root, above the sidebar's provider, and
 * lists its sections with these rows. Before the fix the first row threw
 * "useSidebar must be used within a SidebarProvider." and the app showed its
 * error page instead of the sheet (Limits by account > Effectiveness).
 */
describe("SidebarMenuButton outside a SidebarProvider", () => {
  it("renders a sheet's section list and handles clicks", async () => {
    const onClick = vi.fn();
    await act(async () =>
      root.render(
        <SidebarContent>
          <SidebarGroup>
            <nav aria-label="Usage sections">
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton isActive aria-current="page">
                    Cost
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton onClick={onClick}>Limits</SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </nav>
          </SidebarGroup>
        </SidebarContent>,
      ),
    );
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["Cost", "Limits"]);
    expect(buttons[0]?.getAttribute("data-active")).toBe("true");
    await act(async () => buttons[1]?.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("renders a row with a tooltip, which an expanded sidebar keeps hidden", async () => {
    await act(async () =>
      root.render(
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Limits">Limits</SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>,
      ),
    );
    expect(container.querySelector("button")?.textContent).toBe("Limits");
  });
});
