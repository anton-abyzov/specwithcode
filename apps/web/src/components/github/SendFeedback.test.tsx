// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(async () => undefined),
}));
vi.mock("../../i18n", () => ({ useTx: () => (text: string) => text }));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => false,
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [{}, {}] }),
}));

import { SendFeedbackButton } from "./SendFeedback";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.openExternal.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byText(name: string): HTMLElement {
  const match = [...document.querySelectorAll<HTMLElement>("button, [role='menuitem']")].find(
    (element) => element.textContent?.trim() === name,
  );
  if (!match) throw new Error(`No element ${name}`);
  return match;
}

async function choose(item: string) {
  act(() => root.render(<SendFeedbackButton />));
  await act(async () => byText("Send feedback").click());
  await act(async () => byText(item).click());
}

it("opens a prefilled bug form with the machine count", async () => {
  await choose("Report a bug");
  const url = new URL(mocks.openExternal.mock.calls[0]![0] as string);
  expect(url.pathname).toBe("/anton-abyzov/specwithcode/issues/new");
  expect(url.searchParams.get("template")).toBe("bug_report.yml");
  expect(url.searchParams.get("environment")).toMatch(/, web app, 2 machines$/);
});

it("links Discussions", async () => {
  await choose("Open Discussions");
  expect(mocks.openExternal).toHaveBeenCalledWith(
    "https://github.com/anton-abyzov/specwithcode/discussions",
  );
});
