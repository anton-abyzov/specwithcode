import { describe, expect, it } from "vite-plus/test";

import { reduceSidebarProjectScopeMenuState } from "./Sidebar.logic";

describe("reduceSidebarProjectScopeMenuState", () => {
  it("clears the query when opening a project window closes the combobox", () => {
    expect(
      reduceSidebarProjectScopeMenuState(
        { open: true, query: "alpha" },
        { type: "project-window-opened" },
      ),
    ).toEqual({ open: false, query: "" });
  });
});
