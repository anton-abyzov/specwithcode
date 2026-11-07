// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  dismissed: false,
  openExternal: vi.fn(async () => undefined),
  update: vi.fn(async () => undefined),
}));
vi.mock("../../i18n", () => ({ useTx: () => (text: string) => text }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { starOnGitHubDismissed: boolean }) => unknown) =>
    select({ starOnGitHubDismissed: mocks.dismissed }),
  useUpdateClientSettings: () => mocks.update,
}));

import { SPECWITHCODE_REPO_URL, StarOnGitHubButton, StarOnGitHubLink } from "./StarOnGitHub";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.dismissed = false;
  mocks.openExternal.mockClear();
  mocks.update.mockClear();
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

it("opens the public repository in the system browser", () => {
  act(() => root.render(<StarOnGitHubLink />));
  act(() => button("Star on GitHub").click());
  expect(mocks.openExternal).toHaveBeenCalledWith(SPECWITHCODE_REPO_URL);
  expect(SPECWITHCODE_REPO_URL).toBe("https://github.com/anton-abyzov/specwithcode");
});

it("remembers when the first-run link is dismissed", () => {
  act(() => root.render(<StarOnGitHubLink />));
  act(() => button("Hide the GitHub star link").click());
  expect(mocks.update).toHaveBeenCalledWith({ starOnGitHubDismissed: true });
});

it("stays hidden on the first-run screen once dismissed", () => {
  mocks.dismissed = true;
  act(() => root.render(<StarOnGitHubLink />));
  expect(container.textContent).toBe("");
});

it("always shows the About button, even after the first-run link is dismissed", () => {
  mocks.dismissed = true;
  act(() => root.render(<StarOnGitHubButton />));
  act(() => button("Star on GitHub").click());
  expect(mocks.openExternal).toHaveBeenCalledWith(SPECWITHCODE_REPO_URL);
});
