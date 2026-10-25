import { cloneElement, type ReactElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { ComposerBannerStack } from "./ComposerBannerStack";

vi.mock("../ui/popover", () => ({
  Popover: "popover",
  PopoverTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, {}, children),
  PopoverPopup: "popup",
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));

let renderer: ReactTestRenderer;
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

it("only offers notice details when the description cannot fit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resize = () => {};
  let mutate = () => {};
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutate = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  let position = "static";
  vi.stubGlobal("getComputedStyle", () => ({ position }));
  let availableWidth = 200;
  const nested = { clientWidth: 100, scrollWidth: 80 };
  const text = {
    querySelectorAll: () => [nested],
    get clientWidth() {
      return (
        availableWidth -
        (renderer?.root.findAllByProps({ "aria-label": "Show notice details" }).length ? 28 : 0)
      );
    },
    scrollWidth: 80,
  };
  await act(() => {
    renderer = create(
      <ComposerBannerStack
        items={[
          {
            id: "usage",
            variant: "info",
            icon: null,
            title: "Usage limits",
            description: "OpenCode",
          },
        ]}
      />,
      {
        createNodeMock: (element) =>
          element.type === "span" ? text : element.type === "button" ? { offsetWidth: 24 } : null,
      },
    );
  });
  const details = () => renderer.root.findAllByProps({ "aria-label": "Show notice details" });
  expect(details()).toHaveLength(0);
  text.scrollWidth = 300;
  await act(() => resize());
  expect(details()).toHaveLength(1);
  // It fits without the icon: the icon must not keep its own overflow alive.
  availableWidth = 308;
  await act(() => resize());
  expect(details()).toHaveLength(0);
  text.scrollWidth = 80;
  await act(() => resize());
  expect(details()).toHaveLength(0);
  nested.scrollWidth = 500;
  await act(() => mutate());
  expect(details()).toHaveLength(1);
  nested.scrollWidth = 80;
  await act(() => mutate());
  expect(details()).toHaveLength(0);
  position = "absolute";
  await act(() => resize());
  expect(details()).toHaveLength(1);
  position = "static";
  await act(() => resize());
  expect(details()).toHaveLength(0);
});

it("keeps a wrap-below notice's title out of the actions' column", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const observer = class {
    observe() {}
    disconnect() {}
  };
  vi.stubGlobal("MutationObserver", observer);
  vi.stubGlobal("ResizeObserver", observer);
  vi.stubGlobal("getComputedStyle", () => ({ position: "static" }));
  const actions = (
    <div data-testid="recovery-actions">
      {["Continue with Claude", "Cancel auto-resume", "Check now", "Snooze until reset"].map(
        (label) => (
          <button key={label} type="button">
            {label}
          </button>
        ),
      )}
    </div>
  );
  const item = {
    id: "usage-limit-recovery:run",
    variant: "warning" as const,
    icon: null,
    title: "Usage limit reached",
    description: "Resets in 4 days",
    actions,
  };
  await act(() => {
    renderer = create(
      <ComposerBannerStack items={[{ ...item, actionsLayout: "wrap-below" as const }]} />,
      { createNodeMock: () => ({ scrollWidth: 0, clientWidth: 0, querySelectorAll: () => [] }) },
    );
  });
  const className = (node: { props: { className?: string } }) => node.props.className ?? "";
  const row = renderer.root.findByProps({ "data-composer-banner-row": "true" });
  // No grid actions column: that column sized to the buttons and squeezed the title to 0 px.
  expect(row.findAll((node) => node.props["data-slot"] === "composer-banner-actions")).toEqual([]);
  expect(row.props["data-composer-banner-layout"]).toBe("inline");
  const wrap = renderer.root.findByProps({ "data-composer-banner-wrap": "true" });
  // Text and actions share the one text column beside the icon.
  expect(className(wrap)).toContain("col-start-2");
  expect(wrap.parent?.props["data-composer-banner-row"]).toBe("true");
  expect(className(wrap)).toMatch(/\bflex-wrap\b/);
  const hostSlot = (slot: string) =>
    wrap.find((node) => typeof node.type === "string" && node.props["data-slot"] === slot);
  const content = hostSlot("composer-banner-content");
  const wrapped = hostSlot("composer-banner-wrapped-actions");
  expect(content.findByProps({ children: "Usage limit reached" })).toBeDefined();
  // The text keeps a 16rem basis and grows; the actions shrink and wrap beneath it.
  expect(className(content)).toContain("flex-[1_1_16rem]");
  expect(className(wrapped)).toContain("flex-[0_1_auto]");
  expect(className(wrapped)).toMatch(/\bflex-wrap\b/);
  expect(className(wrapped)).toContain("min-w-0");
  expect(
    renderer.root
      .findByProps({ "data-slot": "composer-banner-wrapped-actions" })
      .findAllByType("button"),
  ).toHaveLength(4);

  // The default layout keeps its own actions column.
  await act(() => renderer.update(<ComposerBannerStack items={[item]} />));
  expect(
    renderer.root.findAll((node) => node.props["data-slot"] === "composer-banner-actions"),
  ).toHaveLength(1);
  expect(renderer.root.findAllByProps({ "data-composer-banner-wrap": "true" })).toEqual([]);
});

const notice = (
  id: string,
  variant: "default" | "error" | "info" | "warning",
  priority?: "urgent" | "activity" | "notice",
) => ({
  id,
  variant,
  ...(priority ? { priority } : {}),
  icon: null,
  title: id,
  onDismiss: () => {},
});

const surfaces = () =>
  renderer.root.findAll(
    (node) => typeof node.type === "string" && node.props["data-composer-banner-surface"],
  );
const titles = () =>
  surfaces()
    .filter((node) => node.props["data-composer-banner-surface"] === "floating")
    .map(
      (node) =>
        node.findAll(
          (child) => child.type === "span" && child.props.className?.includes("font-medium"),
        )[0]?.props.children,
    );

it("puts a limit ahead of a running watcher, and every notice floats whole", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(
      <ComposerBannerStack
        items={[
          notice("watching #662", "default", "activity"),
          notice("limit", "warning", "urgent"),
        ]}
      />,
    );
  });
  expect(titles()).toEqual(["limit", "watching #662"]);
  expect(surfaces().map((node) => node.props["data-composer-banner-surface"])).toEqual([
    "floating",
    "floating",
  ]);
});

it("orders an account change or limit, then errors, warnings, running work and the rest", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(
      <ComposerBannerStack
        items={[
          notice("info", "info"),
          notice("watcher", "default", "activity"),
          notice("warning", "warning"),
          notice("error", "error"),
          notice("account", "info", "urgent"),
        ]}
      />,
    );
  });
  const toggle = renderer.root.findByProps({ "aria-expanded": false });
  expect(toggle.props.children[1]).toBe("3 more notices");
  await act(() => toggle.props.onClick());
  expect(titles()).toEqual(["account", "error", "warning", "watcher", "info"]);
});

it("folds notices past two into a button that names how many, and Escape folds them back", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(
      <ComposerBannerStack
        items={[
          notice("a", "warning", "urgent"),
          notice("b", "error"),
          notice("c", "default", "activity"),
          notice("d", "info"),
        ]}
      />,
      { createNodeMock: () => ({ focus: () => {} }) },
    );
  });
  const toggle = () =>
    renderer.root.find((node) => node.type === "button" && "aria-expanded" in node.props);
  expect(titles()).toEqual(["a", "b"]);
  expect(toggle().props["aria-expanded"]).toBe(false);
  expect(toggle().props.children[1]).toBe("2 more notices");
  const list = renderer.root.findByProps({ "aria-label": "Notices" });
  expect(toggle().props["aria-controls"]).toBe(list.props.id);
  await act(() => toggle().props.onClick());
  expect(titles()).toEqual(["a", "b", "c", "d"]);
  expect(toggle().props.children[1]).toBe("Show fewer notices");
  const stack = renderer.root.find((node) => node.props["data-composer-notice-stack"] === "true");
  await act(() =>
    stack.props.onKeyDown({ key: "Escape", preventDefault: () => {}, stopPropagation: () => {} }),
  );
  expect(titles()).toEqual(["a", "b"]);
  expect(toggle().props["aria-expanded"]).toBe(false);
});

it("interrupts screen readers only for limits, errors and warnings", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(
      <ComposerBannerStack
        items={[notice("limit", "warning", "urgent"), notice("watcher", "default", "activity")]}
      />,
    );
  });
  expect(
    renderer.root
      .findAll(
        (node) =>
          typeof node.type === "string" &&
          (node.props.role === "alert" || node.props.role === "status"),
      )
      .map((node) => node.props.role),
  ).toEqual(["alert", "status"]);
  expect(renderer.root.findAllByProps({ "aria-label": "Dismiss notice" }).length).toBeGreaterThan(
    0,
  );
});

it("keeps the composer's own drawer attached below the queue", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  await act(() => {
    renderer = create(
      <ComposerBannerStack
        items={[
          { id: "composer-activity", variant: "default", priority: "activity", content: "Syncing" },
          notice("limit", "warning", "urgent"),
        ]}
        attachedAbove={<div data-testid="queue" />}
      />,
    );
  });
  expect(surfaces().map((node) => node.props["data-composer-banner-surface"])).toEqual([
    "floating",
    "attached",
  ]);
});
