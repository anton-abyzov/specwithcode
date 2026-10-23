import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderDriverKind } from "@specweave-studio/contracts";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { describeHarness, describeModelFacts, HarnessDescription } from "./HarnessDescription";

function entry(overrides: Partial<ProviderInstanceEntry> = {}): ProviderInstanceEntry {
  return {
    instanceId: "my-pi",
    driverKind: "pi",
    displayName: "Private Pi",
    enabled: false,
    installed: false,
    status: "warning",
    isAvailable: true,
    isDefault: false,
    snapshot: { message: "Disabled" },
    models: [],
    ...overrides,
  } as ProviderInstanceEntry;
}

describe("HarnessDescription", () => {
  it("shows model facts and per-token billing without inferring missing capabilities", () => {
    expect(
      describeModelFacts({
        slug: "router/model",
        name: "Model",
        isCustom: false,
        capabilities: null,
        billing: "paid-router",
        toolCalls: true,
        imageInput: false,
        contextWindow: 128000,
      }),
    ).toBe("Billed per token · Tools · Text only · 128,000 context");
    expect(
      describeModelFacts({ slug: "default", name: "Default", isCustom: false, capabilities: null }),
    ).toBe("Billing unverified");
  });
  it("does not turn a disabled snapshot's installed=false into a missing binary claim", () => {
    const text = renderToStaticMarkup(<HarnessDescription entry={entry()} />);
    expect(text).toContain("Installation and sign-in are not checked while disabled");
    expect(text).toContain("JSONL RPC");
    expect(text).not.toContain("not installed");
  });
  it("keeps custom instance identity distinct from its runtime and model vendor", () => {
    const item = entry({
      driverKind: ProviderDriverKind.make("opencode"),
      displayName: "Work account",
    });
    expect(describeHarness(item).name).toBe("OpenCode");
    const text = renderToStaticMarkup(<HarnessDescription entry={item} />);
    expect(text).toContain("HTTP API and event stream");
    expect(text).toContain("does not prove subscription access or a free turn");
  });
  it("names the configured ACP agent rather than inventing a vendor", () => {
    expect(
      describeHarness(
        entry({ driverKind: ProviderDriverKind.make("acpRegistry"), displayName: "Copilot work" }),
      ).name,
    ).toBe("Copilot work");
  });
  it("preserves an actionable probe failure instead of saying runtime ready", () => {
    const result = describeHarness(
      entry({
        enabled: true,
        installed: true,
        snapshot: { message: "RPC startup failed" } as ProviderInstanceEntry["snapshot"],
      }),
    );
    expect(result.readiness).toBe("RPC startup failed");
  });
});
