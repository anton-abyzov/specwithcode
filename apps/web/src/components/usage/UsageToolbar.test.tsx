// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
  MenuPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  MenuSeparator: () => <hr />,
  MenuCheckboxItem: ({
    children,
    checked,
    onCheckedChange,
  }: {
    children: ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <label>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      {children}
    </label>
  ),
}));

import { UsageCustomRange } from "./UsageRangeControl";
import { UsageScopeBar } from "./UsageScopeBar";
import { NO_USAGE_FILTERS, type UsageFilters } from "./usageFilters";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("UsageCustomRange", () => {
  it("shows each broken rule and applies only a valid range", () => {
    const onApply = vi.fn();
    act(() =>
      root.render(
        <UsageCustomRange
          initial={{ sinceDay: "2026-11-01", untilDay: "2026-11-15" }}
          today="2026-11-24"
          onApply={onApply}
          onCancel={() => {}}
        />,
      ),
    );
    const until = host.querySelector<HTMLInputElement>('input[aria-label="Until"]')!;
    const since = host.querySelector<HTMLInputElement>('input[aria-label="From"]')!;
    const apply = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply",
    )!;
    expect(host.textContent).toContain("15 days");

    setInput(until, "2026-11-30");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("Until cannot be after today.");
    expect(apply.disabled).toBe(true);

    setInput(until, "2026-10-01");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("From cannot be after Until.");

    setInput(since, "2026-06-01");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "A range can span at most 92 days.",
    );

    setInput(since, "2026-09-15");
    expect(apply.disabled).toBe(false);
    act(() => apply.click());
    expect(onApply).toHaveBeenCalledWith({ sinceDay: "2026-09-15", untilDay: "2026-10-01" });
  });
});

describe("UsageScopeBar", () => {
  it("lists providers, shows notes and narrows by a picked provider", () => {
    let filters: UsageFilters = NO_USAGE_FILTERS;
    const render = () =>
      root.render(
        <UsageScopeBar
          metric="cost"
          filters={filters}
          setFilters={(next) => {
            filters = typeof next === "function" ? next(filters) : next;
            render();
          }}
          driverOptions={["codex", "claudeAgent", "copilot"]}
          projectOptions={["specweave"]}
          periodLabel={null}
          notes={["Project is not applied on Cost: its records carry no project."]}
        />,
      );
    act(render);
    expect(host.textContent).toContain("Providers: All");
    expect(host.querySelector('[aria-label="Filter notes"]')?.textContent).toBe(
      "Project is not applied on Cost: its records carry no project.",
    );
    // Cost cannot apply a project filter, so no Project menu is offered there.
    expect(host.textContent).not.toContain("Project: All");
    const codex = [...host.querySelectorAll("label")].find(
      (label) => label.textContent === "Codex",
    )!;
    act(() => codex.querySelector("input")!.click());
    expect([...filters.drivers]).toEqual(["codex"]);
    expect(host.textContent).toContain("Providers: Codex");
    expect(host.textContent).toContain("Clear filters");
  });

  it("offers the Project menu on Delivered", () => {
    act(() =>
      root.render(
        <UsageScopeBar
          metric="delivered"
          filters={NO_USAGE_FILTERS}
          setFilters={() => {}}
          driverOptions={[]}
          projectOptions={["specweave", "sample-app"]}
          periodLabel={null}
          notes={[]}
        />,
      ),
    );
    expect(host.textContent).toContain("Project: All");
    expect(host.textContent).toContain("sample-app");
  });
});
