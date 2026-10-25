import { EnvironmentId, UsageDay, USAGE_CONTRACT_VERSION } from "@specweave-studio/contracts";
import { mergeUsage } from "@specweave-studio/shared/usageMerge";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useUsage: vi.fn(),
  navigate: vi.fn(),
  canGoBack: true,
}));

vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => testState.navigate,
  useCanGoBack: () => testState.canGoBack,
}));
vi.mock("../../state/usage", async (original) => ({
  ...(await original<typeof import("../../state/usage")>()),
  useUsage: testState.useUsage,
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/sidebar", () => ({ SidebarInset: "div" }));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));
vi.mock("../WorkspaceBreadcrumb", () => ({
  WorkspaceBreadcrumb: "div",
  WorkspaceBreadcrumbItem: "div",
  WorkspaceBreadcrumbSeparator: "span",
}));
vi.mock("../WorkspacePageContainer", () => ({ WorkspacePageContainer: "main" }));
vi.mock("../WorkspacePageHeader", () => ({ WorkspacePageHeader: "header" }));
vi.mock("./UsageProviderChart", () => ({
  // A stand-in that can pin the last day, as a click on the real chart does.
  UsageProviderChart: (props: {
    days: readonly string[];
    onSelectPeriod?: (period: string | null) => void;
  }) => (
    <button
      type="button"
      data-testid="pin-last-day"
      onClick={() => props.onSelectPeriod?.(props.days.at(-1) ?? null)}
    />
  ),
}));
vi.mock("./UsagePriceOverrides", () => ({ UsagePriceOverrides: () => null }));
vi.mock("./usageProviders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./usageProviders")>();
  return {
    ...actual,
    PROVIDER_PRESENTATION: {
      ...actual.PROVIDER_PRESENTATION,
      codex: { color: "white", label: "Codex", mark: "span" },
      claude: { color: "orange", label: "Claude Code", mark: "span" },
    },
  };
});

import { UsagePage } from "./UsagePage";
import { isAppSheetOpen } from "../ui/appSheetState";
const environments = [
  {
    environmentId: EnvironmentId.make("test-environment"),
    label: "Test environment",
    isPending: false,
    canReadDiagnostics: true,
    error: null,
    summary: {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-08-11T12:37:00.000Z",
      sinceDay: UsageDay.make("2026-08-10"),
      untilDay: UsageDay.make("2026-08-11"),
      timeZone: "UTC",
      buckets: [],
      sources: [],
      pricing: { status: "fresh", source: "test", fetchedAt: null, knownModels: 1 },
      scanDurationMs: 1,
    },
  },
];

beforeEach(() => {
  testState.useUsage.mockReturnValue({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments,
    selectedEnvironments: environments,
    isPending: false,
    isPartial: false,
    refresh: vi.fn(),
  });
});

describe("UsagePage Escape navigation", () => {
  let renderer: Root;
  let container: HTMLDivElement;
  let back: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    testState.navigate.mockClear();
    testState.canGoBack = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
    await act(() => {
      renderer.render(<UsagePage />);
    });
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    back.mockRestore();
    vi.unstubAllGlobals();
  });

  function escape(properties: { repeat?: boolean; isComposing?: boolean } = {}) {
    return new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Escape",
      ...properties,
    });
  }

  it("returns to the previous page on Escape", () => {
    document.body.dispatchEvent(escape());
    expect(back).toHaveBeenCalledOnce();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("returns home when there is no previous app page", async () => {
    testState.canGoBack = false;
    await act(() => renderer.render(<UsagePage />));

    document.body.dispatchEvent(escape());
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/" });
    expect(back).not.toHaveBeenCalled();
  });

  it("closes the environment menu before Escape navigates back", async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="menu-trigger"]')!;
    await act(() => trigger.click());
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(() => {
      document.activeElement!.dispatchEvent(escape());
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(back).not.toHaveBeenCalled();

    document.body.dispatchEvent(escape());
    expect(back).toHaveBeenCalledOnce();
  });

  it("clears the model search on Escape instead of leaving the page", async () => {
    window.localStorage.setItem(
      "studio:usage-page-preferences:v1",
      JSON.stringify({ metric: "cost", windowDays: 30 }),
    );
    await act(() => renderer.unmount());
    renderer = createRoot(container);
    await act(() => renderer.render(<UsagePage />));
    window.localStorage.removeItem("studio:usage-page-preferences:v1");
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search models"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(() => {
      search.focus();
      setValue.call(search, "opus");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(search.value).toBe("opus");

    await act(() => {
      search.dispatchEvent(escape());
    });
    expect(search.value).toBe("");
    expect(back).not.toHaveBeenCalled();

    // An empty search lets Escape navigate as before.
    document.body.dispatchEvent(escape());
    expect(back).toHaveBeenCalledOnce();
  });

  it.each([{ repeat: true }, { isComposing: true }])("ignores Escape with %j", (properties) => {
    document.body.dispatchEvent(escape(properties));
    expect(back).not.toHaveBeenCalled();
    expect(testState.navigate).not.toHaveBeenCalled();
  });
});

// @vitest-environment jsdom

describe("UsagePage as an app-wide sheet", () => {
  let renderer: Root;
  let container: HTMLDivElement;
  let back: ReturnType<typeof vi.spyOn>;
  const onClose = vi.fn();
  const PREFERENCES = "studio:usage-page-preferences:v1";

  beforeEach(async () => {
    back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    testState.navigate.mockClear();
    onClose.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    window.localStorage.setItem(PREFERENCES, JSON.stringify({ metric: "cost", windowDays: 30 }));
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
    await act(() => {
      renderer.render(<UsagePage variant="sheet" initialMetric="limits" onClose={onClose} />);
    });
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    back.mockRestore();
    window.localStorage.removeItem(PREFERENCES);
    vi.unstubAllGlobals();
  });

  const sheet = () => document.querySelector<HTMLElement>("[data-usage-sheet]");

  it("renders a labelled modal over the app, outside the page container", () => {
    expect(sheet()?.getAttribute("role")).toBe("dialog");
    expect(container.contains(sheet())).toBe(false);
    expect(document.querySelector('[data-slot="usage-sheet-backdrop"]')).not.toBeNull();
    const labelledBy = sheet()!.getAttribute("aria-labelledby");
    expect(document.getElementById(labelledBy!)?.textContent).toBe("Usage");
  });

  it("opens on Limits without overwriting the saved tab", () => {
    expect(sheet()!.querySelector('[aria-label="Refresh limits"]')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES)!).metric).toBe("cost");
  });

  it("closes on Escape once and never navigates back", async () => {
    await act(async () => {
      sheet()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(onClose).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("closes on a click on the dimmed area but not inside", async () => {
    const press = (target: Element) => {
      target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };
    await act(async () => press(sheet()!));
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => press(document.querySelector('[data-slot="usage-sheet-viewport"]')!));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("tells the page underneath that it owns the keyboard", async () => {
    expect(sheet()!.getAttribute("aria-modal")).toBe("true");
    expect(sheet()!.hasAttribute("data-app-sheet")).toBe(true);
    // The page's window listeners ask the document, since the sheet's menus portal beside it.
    expect(isAppSheetOpen()).toBe(true);
    await act(() => renderer.unmount());
    expect(isAppSheetOpen()).toBe(false);
    renderer = createRoot(container);
  });

  it("takes its own tab shortcuts from inside the sheet", async () => {
    await act(async () => {
      sheet()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }),
      );
    });
    expect(sheet()!.querySelector('[aria-label="Refresh limits"]')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(PREFERENCES)!).metric).toBe("cost");
  });

  it("clears a pinned day on Escape before it closes", async () => {
    await act(async () => {
      sheet()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }),
      );
    });
    const pin = sheet()!.querySelector<HTMLButtonElement>('[data-testid="pin-last-day"]')!;
    await act(async () => pin.click());
    const escapeOnce = async () =>
      act(async () => {
        sheet()!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    await escapeOnce();
    expect(onClose).not.toHaveBeenCalled();
    await escapeOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes from its close button", async () => {
    await act(async () => {
      document.querySelector<HTMLElement>('[aria-label="Close usage"]')!.click();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
