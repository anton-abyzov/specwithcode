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
vi.mock("../../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: (props: Record<string, unknown>) => <button {...props} />,
  PopoverPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

import { ProjectUsageIndicator, SubscriptionUsageSummary } from "./ProjectUsageIndicator";

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
async function render(
  environmentId: EnvironmentId | null = host,
  instanceId: ProviderInstanceId | null = selected,
) {
  await act(async () =>
    root.render(
      <ProjectUsageIndicator
        projectEnvironmentId={environmentId}
        providerInstanceId={instanceId}
        onOpenProjectUsage={() => {}}
      />,
    ),
  );
}
describe("project coordinator usage scope", () => {
  it("shows the selected account's 0% left, never the fleet or same-host account average", async () => {
    await render();
    expect(container.querySelector(".sws-usage-chip-value")?.textContent).toBe("0% left");
    expect(container.querySelector(".sws-usage-chip-item")?.getAttribute("data-tone")).toBe("full");
    expect(container.querySelector(".sws-usage-chip")?.getAttribute("aria-label")).toContain("M4");
    expect(container.querySelector(".sws-usage-chip")?.getAttribute("aria-label")).toContain(
      "Codex limit reached",
    );
  });
  it("updates scope when the project's machine changes", async () => {
    await render();
    await render(other);
    expect(container.querySelector(".sws-usage-chip-value")?.textContent).toBe("98% left");
    expect(container.querySelector(".sws-usage-chip")?.getAttribute("aria-label")).toContain("M1");
  });
  it("updates scope when the coordinator account changes", async () => {
    await render(host, ProviderInstanceId.make("other-account"));
    expect(container.querySelector(".sws-usage-chip-value")?.textContent).toBe("100% left");
  });
  it.each([
    [null, selected],
    [host, null],
    [EnvironmentId.make("missing"), selected],
    [host, ProviderInstanceId.make("missing")],
  ] as const)(
    "never substitutes fleet capacity for an unknown destination",
    async (env, instance) => {
      await render(env, instance);
      expect(container.querySelector(".sws-usage-chip-value")).toBeNull();
    },
  );
  it("keeps the full subscription summary available separately", async () => {
    await act(async () => root.render(<SubscriptionUsageSummary />));
    expect(container.textContent).toContain("3 accounts pooled");
  });
});
