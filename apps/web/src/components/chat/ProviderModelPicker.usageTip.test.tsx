import { ProviderInstanceId, type ServerProvider } from "@specweave-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ReactNode } from "react";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

// Render every tooltip's content inline, so the static markup holds what a hover shows.
vi.mock("../ui/tooltip", async (original) => ({
  ...(await original<typeof import("../ui/tooltip")>()),
  TooltipPopup: ({ children }: { children: ReactNode }) => (
    <div data-test-tooltip="">{children}</div>
  ),
}));
vi.mock("../ui/popover", async (original) => ({
  ...(await original<typeof import("../ui/popover")>()),
  PopoverPopup: () => null,
}));

const instanceId = ProviderInstanceId.make("claudeAgent");

function entry(auth: ServerProvider["auth"]) {
  const now = Date.now();
  const provider: ServerProvider = {
    instanceId,
    driver: "claudeAgent" as ServerProvider["driver"],
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth,
    checkedAt: new Date(now).toISOString(),
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: new Date(now - 60_000).toISOString(),
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 27,
          resetsAt: new Date(now + 2 * 86_400_000).toISOString(),
          windowDurationMins: 10_080,
        },
      ],
    },
  } as ServerProvider;
  return deriveProviderInstanceEntries([provider])[0]!;
}

function tooltips(auth: ServerProvider["auth"]) {
  const markup = renderToStaticMarkup(
    <ProviderModelPicker
      activeInstanceId={instanceId}
      model="claude-opus-5-5"
      lockedProvider={null}
      instanceEntries={[entry(auth)]}
      modelOptionsByInstance={
        new Map([[instanceId, [{ slug: "claude-opus-5-5", name: "Opus 5.5" }]]])
      }
      onInstanceModelChange={() => {}}
      triggerParts={{ provider: "Claude", model: "Opus 5.5" }}
      usage={{ connected: true, environmentId: "env", machineLabel: "linux-mini", running: null }}
      fit="full"
    />,
  );
  return markup.split('data-test-tooltip=""').slice(1);
}

describe("usage gauge tooltip", () => {
  it("names the signed-in account, as the model chip's tooltip does", () => {
    const [chipTip, ringTip] = tooltips({ status: "authenticated", email: "pat@example.com" });
    expect(ringTip).toContain("Click for usage and resets");
    for (const tip of [chipTip, ringTip]) {
      expect(tip).toMatch(/data-model-chip-account="">Signed in as pat@example.com</);
    }
  });

  it("says when the provider reports no account email", () => {
    const [, ringTip] = tooltips({ status: "authenticated" });
    expect(ringTip).toContain("Claude does not report an account email");
  });

  it("has no account line without a sign-in to an account", () => {
    const [, ringTip] = tooltips({ status: "authenticated", type: "apiKey" });
    expect(ringTip ?? "").not.toContain("data-model-chip-account");
  });
});
