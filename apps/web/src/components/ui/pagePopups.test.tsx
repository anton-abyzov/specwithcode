// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createPagePopups, PagePopupsContext, type PagePopups } from "./pagePopups";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

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

function ControlledPopover({
  onOpenChange,
  onOpenChangeComplete,
  busy = false,
}: {
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete?: (open: boolean) => void;
  /** Refuses to close, as a dialog does while it saves. */
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next || !busy) setOpen(next);
      }}
      {...(onOpenChangeComplete ? { onOpenChangeComplete } : {})}
    >
      <PopoverTrigger>Limits</PopoverTrigger>
      <PopoverPopup>Limits by machine</PopoverPopup>
    </Popover>
  );
}

async function renderOpen(
  popups: PagePopups | null,
  onOpenChange = vi.fn(),
  extra: { busy?: boolean; onOpenChangeComplete?: (open: boolean) => void } = {},
) {
  await act(async () =>
    root.render(
      <PagePopupsContext value={popups}>
        <ControlledPopover onOpenChange={onOpenChange} {...extra} />
      </PagePopupsContext>,
    ),
  );
  await act(async () => container.querySelector("button")?.click());
  expect(popup()).not.toBeNull();
  return onOpenChange;
}

describe("page popups", () => {
  it("closes a controlled popover and removes it over two commits", async () => {
    const popups = createPagePopups();
    const onOpenChange = await renderOpen(popups);
    expect(popups.mounted()).toBe(true);

    await act(async () => popups.closeAll());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await act(async () => popups.unmountAll());

    expect(popup()).toBeNull();
    expect(popups.mounted()).toBe(false);
  });

  it("leaves a controlled popup its owner keeps open", async () => {
    const popups = createPagePopups();
    const onOpenChangeComplete = vi.fn();
    const onOpenChange = await renderOpen(popups, vi.fn(), {
      busy: true,
      onOpenChangeComplete,
    });

    await act(async () => popups.closeAll());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    await act(async () => popups.unmountAll());

    expect(popup()).not.toBeNull();
    expect(onOpenChangeComplete).not.toHaveBeenCalledWith(false);
    expect(popups.mounted()).toBe(true);
  });

  it("leaves popups outside a hideable page alone", async () => {
    const onOpenChange = await renderOpen(null);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(popup()).not.toBeNull();
  });

  it("forgets a popup once it unmounts", async () => {
    const popups = createPagePopups();
    await renderOpen(popups);
    await act(async () =>
      root.render(<PagePopupsContext value={popups}>{null}</PagePopupsContext>),
    );
    expect(popups.mounted()).toBe(false);
  });
});
