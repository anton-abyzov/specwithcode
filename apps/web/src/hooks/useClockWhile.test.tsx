import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { lastSeenLabel } from "~/lib/machineStatus";

import { useClockWhile } from "./useClockWhile";

const START = Date.UTC(2026, 10, 14, 21, 49, 42);
let renderer: ReactTestRenderer;
let now = 0;
let renders = 0;

function Probe({ active }: { active: boolean }) {
  const value = useClockWhile(active, 30_000);
  useLayoutEffect(() => {
    now = value;
    renders += 1;
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renders = 0;
});

afterEach(() => {
  act(() => renderer.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps a last-seen label counting while nothing else changes", () => {
  act(() => {
    renderer = create(<Probe active />);
  });
  expect(lastSeenLabel(START, now)).toBe("last seen just now");

  act(() => vi.advanceTimersByTime(5 * 60_000));
  expect(lastSeenLabel(START, now)).toBe("last seen 5m ago");

  act(() => vi.advanceTimersByTime(8 * 60_000));
  expect(lastSeenLabel(START, now)).toBe("last seen 13m ago");
});

it("runs no timer and causes no renders while inactive", () => {
  act(() => {
    renderer = create(<Probe active={false} />);
  });
  const rendersAtStart = renders;
  act(() => vi.advanceTimersByTime(10 * 60_000));
  expect(renders).toBe(rendersAtStart);
  expect(now).toBe(START);
  expect(vi.getTimerCount()).toBe(0);
});

it("starts from the present when it becomes active later", () => {
  act(() => {
    renderer = create(<Probe active={false} />);
  });
  act(() => vi.advanceTimersByTime(60 * 60_000));
  act(() => renderer.update(<Probe active />));
  expect(now).toBe(START + 60 * 60_000);

  act(() => renderer.update(<Probe active={false} />));
  expect(vi.getTimerCount()).toBe(0);
});
