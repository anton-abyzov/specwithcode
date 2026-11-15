// @vitest-environment jsdom
import type { ErrorComponentProps } from "@tanstack/react-router";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  invalidate: vi.fn(),
  reload: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  createRootRoute: (config: object) => config,
  useRouter: () => ({ invalidate: state.invalidate }),
  useLocation: (options: { select: (location: { pathname: string }) => unknown }) =>
    options.select({ pathname: "/" }),
  useRouterState: (options: { select: (routerState: { matches: [] }) => unknown }) =>
    options.select({ matches: [] }),
}));

import { Route } from "./__root";

const errorView = (Route as unknown as { errorComponent: ComponentType<ErrorComponentProps> })
  .errorComponent;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  state.invalidate.mockReset();
  state.reload.mockReset();
  vi.stubGlobal("location", { ...window.location, reload: state.reload });
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function clickTryAgain(error: Error) {
  await act(async () =>
    root.render(createElement(errorView, { error, reset: () => {} } as ErrorComponentProps)),
  );
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Try again",
  );
  if (!button) throw new Error("Try again is not on the error page");
  await act(async () => button.click());
}

it("reloads the page when a split chunk failed to load", async () => {
  await clickTryAgain(
    new TypeError("Failed to fetch dynamically imported module: https://app.test/assets/a-1.js"),
  );
  expect(state.reload).toHaveBeenCalledTimes(1);
  expect(state.invalidate).not.toHaveBeenCalled();
});

it("runs the route again for any other error", async () => {
  await clickTryAgain(new Error("Thread not found"));
  expect(state.invalidate).toHaveBeenCalledTimes(1);
  expect(state.reload).not.toHaveBeenCalled();
});
