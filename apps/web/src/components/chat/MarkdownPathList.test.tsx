// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/i18n", () => ({
  useTx: () => (text: string) => text,
}));

import { MarkdownPathList } from "./MarkdownPathList";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});

it("opens the file from the path the same way the chip does", async () => {
  const open = vi.fn();
  await act(() =>
    root.render(
      <MarkdownPathList
        entries={[
          {
            line: "page.html",
            chip: (
              <button type="button" onClick={open}>
                page.html
              </button>
            ),
            fullPath: "/tmp/page.html",
            missing: false,
          },
          {
            line: "gone.mp4",
            chip: <span>gone.mp4</span>,
            fullPath: "/tmp/gone.mp4",
            missing: true,
          },
        ]}
      />,
    ),
  );
  const paths = container.querySelectorAll("[data-path-list-path]");
  expect(paths[0]?.tagName).toBe("BUTTON");
  expect(paths[1]?.tagName).toBe("CODE");
  expect(paths[1]?.textContent).toContain("not found");
  await act(() => (paths[0] as HTMLButtonElement).click());
  expect(open).toHaveBeenCalledOnce();
});
