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
