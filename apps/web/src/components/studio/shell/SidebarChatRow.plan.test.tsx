// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("./Tip", () => ({ Tip: ({ children }: React.PropsWithChildren) => children }));

const { SidebarChatRow } = await import("./SidebarChatRow");

describe("SidebarChatRow plan count", () => {
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

  it("shares the name's room with the count and keeps the marks outside it", async () => {
    await act(async () =>
      root.render(
        <ul>
          <SidebarChatRow
            title="Plan storage"
            tone="idle"
            tip="Plan storage"
            current={false}
            icon={<span data-icon />}
            plan={<span data-plan>3/4</span>}
            menuItems={null}
            onOpen={() => {}}
          >
            <span data-machine>m1</span>
          </SidebarChatRow>
        </ul>,
      ),
    );
    // The count wraps away inside this box before the name is cut shorter (shell.css).
    const main = container.querySelector(".sws-side-row > .sws-side-row-main")!;
    expect([...main.children].map((child) => child.textContent)).toEqual(["Plan storage", "3/4"]);
    expect(main.nextElementSibling?.hasAttribute("data-machine")).toBe(true);
  });

  it("leaves the name alone in its box without a count", async () => {
    await act(async () =>
      root.render(
        <ul>
          <SidebarChatRow
            title="Plan storage"
            tone="idle"
            tip="Plan storage"
            current={false}
            icon={<span data-icon />}
            menuItems={null}
            onOpen={() => {}}
          />
        </ul>,
      ),
    );
    const main = container.querySelector(".sws-side-row-main")!;
    expect(main.children).toHaveLength(1);
    expect(main.firstElementChild?.className).toBe("sws-side-row-label");
  });
});
