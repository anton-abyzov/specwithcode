// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("../../i18n", () => ({ useTx: () => (text: string) => text }));

import { GitHubStarPromptCard } from "./GitHubStarPromptCard";

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

function button(name: string) {
  const match = [...container.querySelectorAll("button")].find(
    (element) => element.textContent === name || element.getAttribute("aria-label") === name,
  );
  if (!match) throw new Error(`No button ${name}`);
  return match;
}

it("asks calmly with three answers and no reward", () => {
  const handlers = { onStar: vi.fn(), onAlreadyStarred: vi.fn(), onNotNow: vi.fn() };
  act(() => root.render(<GitHubStarPromptCard {...handlers} />));
  expect(container.textContent).toContain("Enjoying SpecWithCode?");
  expect(container.textContent).toContain("A star on GitHub helps other developers find it.");
  act(() => button("Star on GitHub").click());
  act(() => button("Already starred").click());
  act(() => button("Not now").click());
  act(() => button("Close").click());
  expect(handlers.onStar).toHaveBeenCalledTimes(1);
  expect(handlers.onAlreadyStarred).toHaveBeenCalledTimes(1);
  expect(handlers.onNotNow).toHaveBeenCalledTimes(2);
});
