// @vitest-environment jsdom

import { act, createRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createPagePopups, PagePopupsContext, type PagePopups } from "./pagePopups";
import { Popover, PopoverPopup, PopoverTrigger } from "./popover";

import { KeptProjectPages } from "../studio/KeptProjectPages";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./select";
import { Combobox, ComboboxInput, ComboboxPopup, ComboboxList, ComboboxItem } from "./combobox";

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

describe.each(["select", "combobox"] as const)("page %s", (kind) => {
  function LifecycleDropdown({
    open,
    complete,
    actionsRef,
  }: {
    open: boolean;
    complete: (open: boolean) => void;
    actionsRef?: React.RefObject<{ unmount(): void } | null>;
  }) {
    const props = { open, onOpenChangeComplete: complete, actionsRef };
    return kind === "select" ? (
      <Select {...props}>
        <SelectTrigger aria-label="Choice">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="one">One</SelectItem>
        </SelectPopup>
      </Select>
    ) : (
      <Combobox {...props} items={["One"]}>
        <ComboboxInput aria-label="Choice" />
        <ComboboxPopup>
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }
  it("does not report a close on initial mount and completes ordinary closes once", async () => {
    const registry = createPagePopups();
    const complete = vi.fn();
    const show = async (open: boolean) => {
      await act(async () =>
        root.render(
          <PagePopupsContext value={registry}>
            <LifecycleDropdown open={open} complete={complete} />
          </PagePopupsContext>,
        ),
      );
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
    };
    await show(false);
    expect(complete.mock.calls.filter(([open]) => !open)).toHaveLength(0);
    await show(true);
    await show(false);
    expect(complete.mock.calls.filter(([open]) => !open)).toHaveLength(1);
    await show(true);
    await show(false);
    expect(complete.mock.calls.filter(([open]) => !open)).toHaveLength(2);
  });
  it("restores normal completion after a controlled owner refuses navigation close", async () => {
    const registry = createPagePopups();
    const complete = vi.fn();
    const show = async (open: boolean) => {
      await act(async () =>
        root.render(
          <PagePopupsContext value={registry}>
            <LifecycleDropdown open={open} complete={complete} />
          </PagePopupsContext>,
        ),
      );
    };
    await show(true);
    await act(async () => registry.closeAll());
    await act(async () => registry.unmountAll());
    expect(registry.mounted()).toBe(true);
    await show(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(complete.mock.calls.filter(([open]) => !open)).toHaveLength(1);
    expect(registry.mounted()).toBe(false);
  });
  it("unmounts an already closing dropdown before Activity pauses its animation", async () => {
    const complete = vi.fn();
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value: () => [{ finished }],
    });
    try {
      const show = async (key: string, open: boolean) => {
        await act(async () =>
          root.render(
            <KeptProjectPages
              pageKey={key}
              isLive={() => true}
              page={
                key === "one" ? (
                  <LifecycleDropdown open={open} complete={complete} />
                ) : (
                  <section>Two</section>
                )
              }
            />,
          ),
        );
      };
      await show("one", true);
      await show("one", false);
      expect(document.querySelector(`[data-slot='${kind}-popup']`)).not.toBeNull();
      expect(complete.mock.calls.filter(([open]) => !open)).toHaveLength(0);
      await show("two", false);
      expect(document.querySelector(`[data-slot='${kind}-popup']`)).toBeNull();
      expect(complete.mock.calls.filter(([open]) => !open)).toHaveLength(1);
    } finally {
      finish();
      if (original) Object.defineProperty(Element.prototype, "getAnimations", original);
      else delete (Element.prototype as unknown as { getAnimations?: unknown }).getAnimations;
    }
  });
  it("preserves the caller's manual unmount ownership", async () => {
    const registry = createPagePopups();
    const complete = vi.fn();
    const actionsRef = createRef<{ unmount(): void }>();
    const show = async (open: boolean) => {
      await act(async () =>
        root.render(
          <PagePopupsContext value={registry}>
            <LifecycleDropdown open={open} complete={complete} actionsRef={actionsRef} />
          </PagePopupsContext>,
        ),
      );
    };
    await show(true);
    expect(actionsRef.current?.unmount).toBeTypeOf("function");
    await show(false);
    expect(complete.mock.calls.filter(([open]) => !open)).toHaveLength(0);
    await act(async () => actionsRef.current?.unmount());
    expect(complete.mock.calls.filter(([open]) => !open)).toHaveLength(1);
  });
  function Dropdown({ busy = false, controlled = false, cancel = false, changed = vi.fn() }) {
    const [open, setOpen] = useState(true);
    const props = {
      ...(controlled ? { open } : { defaultOpen: true }),
      onOpenChange(next: boolean, details: { cancel(): void }) {
        changed(next);
        if (cancel) details.cancel();
        else if (!busy) setOpen(next);
      },
    };
    return kind === "select" ? (
      <Select {...props}>
        <SelectTrigger aria-label="Choice">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="one">One</SelectItem>
        </SelectPopup>
      </Select>
    ) : (
      <Combobox {...props} items={["One"]}>
        <ComboboxInput aria-label="Choice" />
        <ComboboxPopup>
          <ComboboxList>
            {(item: string) => (
              <ComboboxItem key={item} value={item}>
                {item}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }
  it("removes a dropdown when a real retained page hides and does not reopen on return", async () => {
    const page = (
      <section>
        <Dropdown />
      </section>
    );
    await act(async () =>
      root.render(<KeptProjectPages pageKey="one" isLive={() => true} page={page} />),
    );
    expect(document.querySelector(`[data-slot='${kind}-popup']`)).not.toBeNull();
    await act(async () =>
      root.render(
        <KeptProjectPages pageKey="two" isLive={() => true} page={<section>Two</section>} />,
      ),
    );
    expect(document.querySelector(`[data-slot='${kind}-popup']`)).toBeNull();
    await act(async () =>
      root.render(<KeptProjectPages pageKey="one" isLive={() => true} page={page} />),
    );
    const returned = document.querySelector(`[data-slot='${kind}-popup']`);
    // Select may mount a hidden label-measurement portal on effect reconnect.
    // It must remain closed and have a hidden positioner, never reopen.
    if (returned) {
      expect(returned.hasAttribute("data-closed")).toBe(true);
      expect(returned.closest("[hidden]")).not.toBeNull();
    }
  });
  const content = () => document.querySelector(`[data-slot='${kind}-popup']`);
  it.each([false, true])("closes and unmounts with controlled=%s", async (controlled) => {
    const registry = createPagePopups();
    const changed = vi.fn();
    await act(async () =>
      root.render(
        <PagePopupsContext value={registry}>
          <Dropdown controlled={controlled} changed={changed} />
        </PagePopupsContext>,
      ),
    );
    expect(content()).not.toBeNull();
    expect(registry.mounted()).toBe(true);
    await act(async () => registry.closeAll());
    expect(changed).toHaveBeenLastCalledWith(false);
    await act(async () => registry.unmountAll());
    const closed = content();
    if (closed) {
      expect(closed.hasAttribute("data-closed")).toBe(true);
      expect(closed.closest("[hidden]")).not.toBeNull();
    }
    expect(registry.mounted()).toBe(false);
  });
  it.each(["controlled", "cancel"])("preserves a refused close (%s)", async (mode) => {
    const registry = createPagePopups();
    await act(async () =>
      root.render(
        <PagePopupsContext value={registry}>
          <Dropdown controlled={mode === "controlled"} busy cancel={mode === "cancel"} />
        </PagePopupsContext>,
      ),
    );
    await act(async () => registry.closeAll());
    await act(async () => registry.unmountAll());
    expect(content()).not.toBeNull();
    expect(registry.mounted()).toBe(true);
  });
});
