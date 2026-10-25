// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
} from "@specweave-studio/contracts";
import type { LimitPresentations } from "@specweave-studio/shared/usageLimits";

const state = vi.hoisted(() => ({ presentations: new Map() as LimitPresentations }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.presentations }));
vi.mock("../../../state/presentation", () => ({
  environmentPresentations: { presentationsAtom: {} },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));
vi.mock("../../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../../settings/providerDriverMeta", () => ({
  getDriverOption: (id: string) => ({ label: id === "codex" ? "Codex" : "Claude" }),
}));
vi.mock("../../usage/UsageLimits", () => ({ resetCreditsSummary: () => "" }));
vi.mock("./HostLimits", () => ({ HostLimitsCompact: () => null }));

import { MachineLimitsPanel, SubscriptionUsageSummary } from "./ProjectUsageIndicator";
import { closeUsageSheet, useUsageSheetRequest } from "../../usage/usageSheetStore";

const host = EnvironmentId.make("m4");
const other = EnvironmentId.make("m1");
const selected = ProviderInstanceId.make("codex");
function provider(instanceId: string, usedPercent: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: null,
    checkedAt: new Date().toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    status: "ready",
    auth: {
      status: "authenticated",
      type: "chatgpt",
      email: `${instanceId}-${usedPercent}@example.test`,
    },
    usageLimits: {
      checkedAt: new Date().toISOString(),
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          kind: "weekly",
          usedPercent,
          resetsAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ],
    },
  };
}
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.presentations = new Map([
    [
      host,
      {
        entry: { target: { label: "M4" } },
        serverConfig: { providers: [provider("codex", 100), provider("other-account", 0)] },
      },
    ],
    [
      other,
      { entry: { target: { label: "M1" } }, serverConfig: { providers: [provider("codex", 2)] } },
    ],
  ]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
describe("machine limits", () => {
  it("lists every machine's sign-ins and goes back to the models", async () => {
    const back = vi.fn();
    await act(async () =>
      root.render(
        <MachineLimitsPanel
          projectEnvironmentId={host}
          coordinatorInstanceId={selected}
          onBack={back}
          onOpenProjectUsage={() => {}}
        />,
      ),
    );
    expect(container.textContent).toContain("Limits by machine");
    expect(container.textContent).toContain("This project's tokens");
    const backButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Models",
    );
    await act(async () => backButton!.click());
    expect(back).toHaveBeenCalledOnce();
  });
  it("opens all limits as an app-wide sheet on Limits after closing its popover", async () => {
    closeUsageSheet();
    const calls: string[] = [];
    const close = vi.fn(() => {
      calls.push(useUsageSheetRequest.getState().request ? "close-after-open" : "close");
    });
    await act(async () =>
      root.render(
        <MachineLimitsPanel
          projectEnvironmentId={host}
          coordinatorInstanceId={selected}
          onClose={close}
        />,
      ),
    );
    const button = [...container.querySelectorAll("button")].find((element) =>
      element.textContent?.includes("All limits and accounts"),
    );
    expect(button?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(container.querySelector("a")?.textContent ?? "").not.toContain("All limits");
    await act(async () => button!.click());
    expect(calls).toEqual(["close"]);
    expect(useUsageSheetRequest.getState().request?.metric).toBe("limits");
    closeUsageSheet();
  });
  it("keeps the full subscription summary available separately", async () => {
    await act(async () => root.render(<SubscriptionUsageSummary />));
    expect(container.textContent).toContain("3 accounts pooled");
  });
});
