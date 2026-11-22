// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SheetView } from "./SheetView";

const MONTHS = Array.from({ length: 24 }, (_, index) => index + 1);

function workbook(animate: boolean): string {
  const cells: Record<string, string | number> = {
    A1: "Region",
    B1: "Sales",
    A2: "North",
    B2: 40,
    A3: "South",
    B3: 10,
    A4: "East",
    B4: 30,
    A5: "North",
    B5: 20,
  };
  for (const month of MONTHS) {
    cells[`D${month}`] = month;
    cells[`E${month}`] = 1000 - month * 25;
  }
  const charts = [
    { id: "bars", type: "bar", title: "Sales by region", labels: "A2:A5", values: "B2:B5" },
    { id: "cols", type: "column", title: "Sales columns", labels: "A2:A5", values: "B2:B5" },
    { id: "line", type: "line", title: "Balance", labels: "D1:D24", values: "E1:E24" },
    { id: "ring", type: "donut", title: "Share", labels: "A2:A5", values: "B2:B5" },
  ].map((chart) => (animate ? chart : { ...chart, animate: false }));
  return JSON.stringify({ v: 1, kind: "sheet", title: "Motion", tabs: [{ name: "Data", cells, charts }] });
}

let container: HTMLDivElement;
let root: Root;
let animations: Array<{ readonly key: string | undefined; readonly from: string }>;

function chart(id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-chart-id="${id}"]`)!;
}

function barKeys(): string[] {
  return [...chart("bars").querySelectorAll<HTMLElement>("[data-motion-key]")].map(
    (row) => row.dataset.motionKey!,
  );
}

function reducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: reduce && query.includes("prefers-reduced-motion"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

async function show(text: string): Promise<void> {
  await act(async () => root.render(<SheetView text={text} mode="light" />));
}

async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  animations = [];
  // jsdom lays nothing out: a row's place is its position in the list.
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      return this.parentElement ? [...this.parentElement.children].indexOf(this) * 30 : 0;
    },
  });
  HTMLElement.prototype.animate = function animate(this: HTMLElement, frames: unknown) {
    const first = (frames as ReadonlyArray<{ readonly transform: string }>)[0]!;
    animations.push({ key: this.dataset.motionKey, from: first.transform });
    return {} as Animation;
  };
  reducedMotion(false);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "offsetTop");
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("chart motion", () => {
  it("staggers the marks of each chart and keeps a key per label", async () => {
    await show(workbook(true));
    expect(chart("bars").dataset.animate).toBe("on");
    // Two rows share the label North and still get their own key.
    expect(barKeys()).toEqual(["North", "South", "East", "North\u00001"]);
    const delays = [...chart("bars").querySelectorAll<HTMLElement>("[data-motion-key]")].map((row) =>
      row.style.getPropertyValue("--office-delay"),
    );
    expect(delays).toEqual(["0ms", "34ms", "68ms", "102ms"]);

    const line = chart("line").querySelector(".office-chart-line")!;
    expect(line.getAttribute("pathLength")).toBe("1");
    expect(chart("line").querySelector(".office-chart-area")).not.toBeNull();
    // 24 points: no dot per point, only the one under the pointer.
    expect(chart("line").querySelectorAll(".office-chart-dot")).toHaveLength(0);
    expect(chart("cols").querySelectorAll(".office-chart-col")).toHaveLength(4);
    expect(chart("ring").querySelector(".office-donut-sweep")).not.toBeNull();
  });

  it("moves bar rows to their new place when the order changes", async () => {
    await show(workbook(true));
    const rows = [...chart("bars").querySelectorAll("[data-motion-key]")];
    expect(animations).toEqual([]);

    await choose(chart("bars").querySelector<HTMLSelectElement>("[data-chart-sort]")!, "value-desc");
    expect(barKeys()).toEqual(["North", "East", "North\u00001", "South"]);
    // The same elements, moved: nothing was mounted again.
    const after = [...chart("bars").querySelectorAll("[data-motion-key]")];
    expect(new Set(after)).toEqual(new Set(rows));
    expect(animations).toEqual([
      { key: "East", from: "translateY(30px)" },
      { key: "North\u00001", from: "translateY(30px)" },
      { key: "South", from: "translateY(-60px)" },
    ]);
  });

  it("reads out the mark under the keyboard and clears it on Escape", async () => {
    await show(workbook(true));
    const plot = chart("line").querySelector<SVGElement>(".office-chart-plot")!;
    const readout = chart("line").querySelector("[aria-live]")!;
    const press = (key: string) =>
      act(async () => {
        plot.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    await press("ArrowRight");
    expect(readout.textContent).toBe("1: 975");
    await press("ArrowRight");
    expect(readout.textContent).toBe("2: 950");
    expect(chart("line").querySelectorAll('.office-chart-dot[data-on="true"]')).toHaveLength(1);
    await press("End");
    expect(readout.textContent).toBe("24: 400");
    await press("Escape");
    expect(readout.textContent).toBe("");
  });

  it("shows the final picture at once for animate: false and for reduced motion", async () => {
    await show(workbook(false));
    expect(chart("bars").dataset.animate).toBe("off");
    expect(chart("ring").querySelector(".office-chart-total")!.textContent).toBe("100");
    await choose(chart("bars").querySelector<HTMLSelectElement>("[data-chart-sort]")!, "value-desc");
    expect(animations).toEqual([]);

    reducedMotion(true);
    await act(async () => root.render(null));
    await show(workbook(true));
    expect(chart("ring").querySelector(".office-chart-total")!.textContent).toBe("100");
    await choose(chart("bars").querySelector<HTMLSelectElement>("[data-chart-sort]")!, "value-asc");
    expect(animations).toEqual([]);
  });

  it("counts the donut total up to the figure", async () => {
    let now = 0;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    await show(workbook(true));
    const total = () => chart("ring").querySelector(".office-chart-total")!.textContent;
    expect(total()).toBe("0");
    const step = async (at: number) => {
      now = at;
      const due = frames.splice(0);
      await act(async () => {
        for (const frame of due) frame(at);
      });
    };
    await step(350);
    expect(Number(total())).toBeGreaterThan(50);
    expect(Number(total())).toBeLessThan(100);
    await step(700);
    expect(total()).toBe("100");
    expect(frames).toHaveLength(0);
    vi.restoreAllMocks();
  });
});
