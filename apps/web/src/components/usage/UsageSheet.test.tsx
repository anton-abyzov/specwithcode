// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const routing = vi.hoisted(() => ({ pathname: "/projects/specweave" }));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: routing.pathname }),
}));
vi.mock("./UsagePage", () => ({
  UsagePage: (props: { variant: string; initialMetric: string; onClose: () => void }) => (
    <div role="dialog" data-variant={props.variant} data-metric={props.initialMetric}>
      <button type="button" onClick={props.onClose}>
        Close usage
      </button>
    </div>
  ),
}));

import { rememberSettingsOpener } from "../settings/settingsReturnFocus";
import { UsageSheetHost } from "./UsageSheet";
import { closeUsageSheet, openUsageSheet, useUsageSheetRequest } from "./usageSheetStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLElement;
let chip: HTMLButtonElement;

beforeEach(async () => {
  routing.pathname = "/projects/specweave";
  closeUsageSheet();
  chip = document.createElement("button");
  chip.setAttribute("aria-label", "Coordinator subscription usage");
  document.body.append(chip);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<UsageSheetHost />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
});

const frames = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("UsageSheetHost", () => {
  it("renders Usage as a sheet on Limits and returns focus to the opener", async () => {
    chip.focus();
    rememberSettingsOpener(chip);
    await act(async () => openUsageSheet({ metric: "limits" }));
    const sheet = container.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(sheet.dataset.variant).toBe("sheet");
    expect(sheet.dataset.metric).toBe("limits");

    sheet.querySelector("button")!.focus();
    await act(async () => {
      sheet.querySelector("button")!.click();
      await frames();
    });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it("closes when the app navigates away from the page it covered", async () => {
    await act(async () => openUsageSheet());
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    routing.pathname = "/settings/general";
    await act(async () => root.render(<UsageSheetHost />));
    expect(useUsageSheetRequest.getState().request).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
