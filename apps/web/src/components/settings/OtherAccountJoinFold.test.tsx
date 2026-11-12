import { act } from "react";
import { create, type ReactTestInstance } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const search = vi.hoisted(() => ({ targetId: null as string | null, scroll: vi.fn() }));
vi.mock("./settingsLayout", () => ({
  useSettingsSearchTargetId: () => search.targetId,
  scrollToSettingsTarget: search.scroll,
}));

import { OtherAccountJoinFold } from "./OtherAccountJoinFold";

const ids = ["private-machines-add", "private-machines-invite"];

function textOf(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

async function mount(openFor = false) {
  let renderer: ReturnType<typeof create> | null = null;
  const element = (next: boolean) => (
    <OtherAccountJoinFold openFor={next} targetIds={ids}>
      <p id="private-machines-invite">Join a main machine</p>
    </OtherAccountJoinFold>
  );
  await act(async () => {
    renderer = create(element(openFor));
  });
  const details = () => renderer!.root.findByType("details");
  return {
    details,
    summary: () => textOf(renderer!.root.findByType("summary")),
    /** What the browser reports when the owner, or a search jump, toggles the section. */
    toggle: (open: boolean) =>
      act(async () => details().props.onToggle({ currentTarget: { open } })),
    update: (next: boolean) => act(async () => renderer!.update(element(next))),
    unmount: () => act(async () => renderer!.unmount()),
  };
}

beforeEach(() => {
  search.targetId = null;
  search.scroll.mockClear();
});

describe("Another account, or no Connect", () => {
  it("starts closed with its one line and a Show control, and keeps what is inside mounted", async () => {
    const view = await mount();
    expect(view.details().props.open).toBe(false);
    expect(view.summary()).toBe(
      "Another account, or no ConnectA friend's machine, or one that cannot reach SpecWithCode Connect, joins with a code or a join line.Show",
    );
    // Still in the page while closed, so a settings-search jump can find it.
    expect(view.details().findByProps({ id: "private-machines-invite" })).toBeDefined();
    await view.unmount();
  });

  it("opens with Show and folds again with Hide", async () => {
    const view = await mount();
    await view.toggle(true);
    expect(view.details().props.open).toBe(true);
    expect(view.summary()).toContain("Hide");
    await view.toggle(false);
    expect(view.details().props.open).toBe(false);
    expect(view.summary()).toContain("Show");
    await view.unmount();
  });

  it("opens when something inside starts being used", async () => {
    const view = await mount();
    await view.update(true);
    expect(view.details().props.open).toBe(true);
    await view.unmount();
  });

  it("starts open when something inside is already in use", async () => {
    const view = await mount(true);
    expect(view.details().props.open).toBe(true);
    await view.unmount();
  });

  it("lets the owner fold it again while it is in use, and opens for the next use", async () => {
    const view = await mount(true);
    await view.toggle(false);
    expect(view.details().props.open).toBe(false);
    // Another render with nothing new must not force it back open.
    await view.update(true);
    expect(view.details().props.open).toBe(false);
    await view.update(false);
    await view.update(true);
    expect(view.details().props.open).toBe(true);
    await view.unmount();
  });

  it("stays open after its reason ends, so the page does not jump", async () => {
    const view = await mount(true);
    await view.update(false);
    expect(view.details().props.open).toBe(true);
    await view.unmount();
  });

  it("opens for a settings-search jump to something inside, not for one elsewhere", async () => {
    search.targetId = "machine-work-grants";
    const elsewhere = await mount();
    expect(elsewhere.details().props.open).toBe(false);
    expect(search.scroll).not.toHaveBeenCalled();
    await elsewhere.unmount();
    for (const id of ids) {
      search.targetId = id;
      const view = await mount();
      expect(view.details().props.open).toBe(true);
      // The jump lands on the row itself.
      expect(search.scroll).toHaveBeenLastCalledWith(id);
      await view.unmount();
    }
    expect(search.scroll).toHaveBeenCalledTimes(2);
  });

  it("opens when the jump arrives after the page is already shown", async () => {
    const view = await mount();
    search.targetId = "private-machines-add";
    await view.update(false);
    expect(view.details().props.open).toBe(true);
    expect(search.scroll).toHaveBeenCalledExactlyOnceWith("private-machines-add");
    await view.unmount();
  });

  it("does not scroll when it opens for a typed line or an open dialog", async () => {
    const view = await mount(true);
    expect(search.scroll).not.toHaveBeenCalled();
    await view.unmount();
  });
});
