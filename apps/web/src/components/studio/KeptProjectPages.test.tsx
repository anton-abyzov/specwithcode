// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { KeptProjectPages } from "./KeptProjectPages";

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

const popup = () => document.querySelector("[data-slot='popover-popup']");

/** A page whose effect acts on a selection prop, as the thread pane's correction does. */
function Page({
  name,
  selected,
  select,
}: {
  name: string;
  selected: string;
  select: (id: string) => void;
}) {
  useEffect(() => {
    if (selected !== "host") select("host");
  }, [selected, select]);
  return (
    <div data-page={name}>
      <Popover>
        <PopoverTrigger>Open {name}</PopoverTrigger>
        <PopoverPopup>{name} details</PopoverPopup>
      </Popover>
    </div>
  );
}

async function show(name: string, selected: string, select: (id: string) => void) {
  await act(async () =>
    root.render(
      <KeptProjectPages
        pageKey={name}
        page={<Page key={name} name={name} selected={selected} select={select} />}
        isLive={() => true}
      />,
    ),
  );
}

describe("kept project pages", () => {
  it("closes a popup of the page left without rendering it with the props it was entered with", async () => {
    const selectA = vi.fn();
    // Entered from a link to a subagent; its effect moves the selection to the host.
    await show("a", "subagent", selectA);
    expect(selectA).toHaveBeenCalledWith("host");
    await show("a", "host", selectA);
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-page='a'] button")?.click(),
    );
    expect(popup()).not.toBeNull();
    selectA.mockClear();

    await show("b", "host", vi.fn());

    expect(popup()).toBeNull();
    expect(selectA).not.toHaveBeenCalled();
    // The page left is kept, hidden.
    expect(container.querySelector<HTMLElement>("[data-page='a']")?.style.display).toBe("none");
    expect(container.querySelector<HTMLElement>("[data-page='b']")?.style.display).not.toBe("none");
  });

  it("hides a page left without popups at once", async () => {
    await show("a", "host", vi.fn());
    await show("b", "host", vi.fn());
    expect(container.querySelector<HTMLElement>("[data-page='a']")?.style.display).toBe("none");
    expect(container.querySelector<HTMLElement>("[data-page='b']")?.style.display).not.toBe("none");
  });
});
