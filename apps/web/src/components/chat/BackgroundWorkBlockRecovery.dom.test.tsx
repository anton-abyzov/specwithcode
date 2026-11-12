// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  BackgroundWorkBlockRecovery,
  useBackgroundWorkBlockRecovery,
} from "./BackgroundWorkBlockRecovery";

type HookInput = Parameters<typeof useBackgroundWorkBlockRecovery>[0];

let root: Root;
let container: HTMLDivElement;
let stopBackgroundWork: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
let continueRun: ReturnType<typeof vi.fn<() => void>>;

function Harness(props: Partial<HookInput>) {
  const recovery = useBackgroundWorkBlockRecovery({
    threadKey: "env:thread-1",
    failureCode: "background_work_blocks_change",
    backgroundWorkRunning: true,
    enabled: true,
    stopping: false,
    stopBackgroundWork,
    continueRun,
    ...props,
  });
  return recovery ? <BackgroundWorkBlockRecovery recovery={recovery} /> : <p>no action</p>;
}

const render = (props: Partial<HookInput> = {}) =>
  act(async () => root.render(<Harness {...props} />));
const button = () => container.querySelector<HTMLButtonElement>("button");
const click = () => act(async () => button()?.click());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  stopBackgroundWork = vi.fn(async () => true);
  continueRun = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useBackgroundWorkBlockRecovery", () => {
  it("offers nothing for another failure, a run that cannot continue, or ended work", async () => {
    for (const props of [
      { failureCode: "unauthorized" },
      { failureCode: null },
      { enabled: false },
      { backgroundWorkRunning: false },
    ]) {
      await render(props);
      expect(container.textContent).toBe("no action");
    }
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("stops the work, then continues once it has left the list", async () => {
    await render();
    expect(button()?.textContent).toBe("Stop background work and continue");
    await click();
    expect(stopBackgroundWork).toHaveBeenCalledTimes(1);
    expect(continueRun).not.toHaveBeenCalled();
    expect(button()?.disabled).toBe(true);
    expect(button()?.textContent).toBe("Stopping background work…");

    await render({ backgroundWorkRunning: false });
    expect(continueRun).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("no action");
    // Nothing is owed any more: later renders and the timeout continue nothing.
    await render({ backgroundWorkRunning: true });
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(continueRun).toHaveBeenCalledTimes(1);
  });

  it("continues after 8 seconds when the list never drops the work", async () => {
    await render();
    await click();
    await act(async () => vi.advanceTimersByTime(7_999));
    expect(continueRun).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(1));
    expect(continueRun).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(continueRun).toHaveBeenCalledTimes(1);
    expect(button()?.disabled).toBe(false);
  });

  it("does not continue when the stop was refused", async () => {
    stopBackgroundWork.mockResolvedValue(false);
    await render();
    await click();
    await render({ backgroundWorkRunning: false });
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(continueRun).not.toHaveBeenCalled();
  });

  it.each([
    ["the person opens another thread", { threadKey: "env:thread-2" }],
    ["another message replaced the failure", { failureCode: null }],
    ["the run can no longer continue", { enabled: false }],
  ])("drops the owed continue when %s", async (_, moved) => {
    await render();
    await click();
    await render(moved);
    await act(async () => vi.advanceTimersByTime(60_000));
    // Coming back never replays it without a new click.
    await render({ backgroundWorkRunning: false });
    await render();
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(continueRun).not.toHaveBeenCalled();
  });

  it("shows the stop in progress as busy", async () => {
    await render({ stopping: true });
    expect(button()?.disabled).toBe(true);
  });
});
