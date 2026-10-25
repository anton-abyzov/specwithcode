// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => ({}) }));
vi.mock("~/logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: (project: { id: string }) => `key-${project.id}`,
  selectProjectGroupingSettings: () => ({}),
}));

const { MissingDesignDetail } = await import("./MissingDesignDetail");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const project = { id: "gone", title: "Gone app", workspaceRoot: "/Users/me/gone" } as never;

describe("MissingDesignDetail", () => {
  it("names the project and its missing folder and opens the project", () => {
    act(() =>
      root.render(
        <MissingDesignDetail detail="The folder /Users/me/gone is missing." project={project} />,
      ),
    );
    expect(container.textContent).toBe(
      "Gone app: its folder /Users/me/gone is missing. Open Gone app",
    );
    act(() => container.querySelector("button")!.click());
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectKey",
      params: { projectKey: "key-gone" },
    });
  });

  it("keeps any other reason as the server said it", () => {
    act(() => root.render(<MissingDesignDetail detail="It was deleted." project={project} />));
    expect(container.textContent).toBe("It was deleted.");
  });
});
