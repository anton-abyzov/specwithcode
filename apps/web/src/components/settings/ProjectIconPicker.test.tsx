// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ProjectIconPickerPanel", () => ({
  ProjectIconPickerPanel: () => <div data-testid="panel" />,
}));

import { ProjectIconPicker, useLatestIconSave } from "./ProjectIconPicker";

describe("useLatestIconSave", () => {
  it("runs saves one at a time and keeps only the latest pick made meanwhile", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const saved: string[] = [];
    const releases: Array<() => void> = [];
    let save: ((change: string) => Promise<unknown>) | null = null;
    function Probe({ onReady }: { onReady: (next: (change: string) => Promise<unknown>) => void }) {
      const latest = useLatestIconSave(async (change: string) => {
        saved.push(change);
        await new Promise<void>((resolve) => releases.push(resolve));
      });
      useEffect(() => onReady(latest), [latest, onReady]);
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() =>
      root.render(
        <Probe
          onReady={(next) => {
            save = next;
          }}
        />,
      ),
    );

    const first = save!("rocket");
    void save!("bot");
    void save!("star");
    expect(saved).toEqual(["rocket"]);
    await act(async () => releases.shift()!());
    expect(saved).toEqual(["rocket", "star"]);
    await act(async () => releases.shift()!());
    await first;
    expect(saved).toEqual(["rocket", "star"]);
    act(() => root.unmount());
  });
});

describe("useLatestIconSave settles", () => {
  it("resolves every caller only after the latest pick has saved", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const saved: string[] = [];
    const releases: Array<() => void> = [];
    let save: ((change: string) => Promise<unknown>) | null = null;
    function Probe() {
      const latest = useLatestIconSave(async (change: string) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        saved.push(change);
        if (change === "green") throw new Error("offline");
      });
      useEffect(() => {
        save = latest;
      }, [latest]);
      return null;
    }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe />));
    const settled: string[] = [];
    const first = save!("blue").then(() => settled.push("first"));
    const second = save!("red").then(() => settled.push("second"));
    await act(async () => releases.shift()!());
    expect(saved).toEqual(["blue"]);
    expect(settled).toEqual([]);
    await act(async () => releases.shift()!());
    await Promise.all([first, second]);
    expect(saved).toEqual(["blue", "red"]);
    expect(settled).toEqual(["first", "second"]);
    // A failed save still settles and lets the next pick run.
    const failing = save!("green");
    void save!("amber");
    await act(async () => releases.shift()!());
    await act(async () => releases.shift()!());
    await failing;
    expect(saved).toEqual(["blue", "red", "green", "amber"]);
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
    act(() => root.unmount());
  });
});

describe("ProjectIconPicker", () => {
  it("stays closed after a lock is lifted", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const draw = (disabled: boolean) =>
      root.render(
        <ProjectIconPicker
          trigger={<button type="button">Icon</button>}
          current={null}
          customized={false}
          projectName="Atlas"
          disabled={disabled}
          onSelect={() => {}}
          onReset={() => {}}
        />,
      );
    await act(async () => draw(false));
    await act(async () => container.querySelector("button")!.click());
    expect(document.querySelector('[data-testid="panel"]')).not.toBeNull();
    await act(async () => draw(true));
    await act(async () => draw(false));
    expect(document.querySelector('[data-testid="panel"]')).toBeNull();
    await act(async () => root.unmount());
    container.remove();
  });
});
