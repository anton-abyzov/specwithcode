import type { ServerProvider } from "@specweave-studio/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { openModelPickerLabel } from "./openModelPickerLabel";
import { TooltipProvider } from "../ui/tooltip";
import { ProviderGroupHeader, providerGroupAccount } from "./ProviderGroupHeader";

// Fictional instances only; no key or account here is real.
const entry = (snapshot: Partial<ServerProvider>): ProviderInstanceEntry =>
  ({
    instanceId: "fixture",
    driverKind: "claudeAgent",
    displayName: "Fixture",
    snapshot: {
      auth: { status: "authenticated", type: "subscription", label: "Max subscription" },
      ...snapshot,
    },
    models: [],
  }) as never;

describe("openModelPickerLabel", () => {
  it("labels a key preset 'Your key' with the vendor's list-price note", () => {
    expect(openModelPickerLabel({ openModelPreset: "deepseek" })).toEqual({
      label: "Your key",
      note: "DeepSeek bills your key at its own list price.",
    });
    expect(openModelPickerLabel({ openModelPreset: "zai" })?.label).toBe("Your key");
    expect(openModelPickerLabel({ openModelPreset: "openrouter" })?.label).toBe("Your key");
  });

  it("labels a local preset 'Local' with where it runs", () => {
    expect(openModelPickerLabel({ openModelPreset: "ollama" })).toEqual({
      label: "Local",
      note: "Runs on your own Ollama.",
    });
    expect(openModelPickerLabel({ openModelPreset: "lmstudio" })?.label).toBe("Local");
  });

  it("returns null without a known marker (D-05)", () => {
    expect(openModelPickerLabel(null)).toBeNull();
    expect(openModelPickerLabel(undefined)).toBeNull();
    expect(openModelPickerLabel({})).toBeNull();
    expect(openModelPickerLabel({ openModelPreset: "mistral" })).toBeNull();
  });
});

describe("providerGroupAccount for an open-model route", () => {
  it("shows the route label once, with the note, in place of the plan and account", () => {
    // The server stamps auth.label with the same words; the pill shows them once.
    const account = providerGroupAccount(
      entry({
        openModelPreset: "deepseek",
        auth: {
          status: "authenticated",
          type: "apiKey",
          label: "Your key",
          email: "person@example.com",
        },
      } as never),
    );
    expect(account).toEqual({
      plan: "Your key",
      email: null,
      note: "DeepSeek bills your key at its own list price.",
    });
    expect(providerGroupAccount(entry({ openModelPreset: "ollama" }))).toMatchObject({
      plan: "Local",
      note: "Runs on your own Ollama.",
    });
  });

  it("never shows 'Subscription' for a route, even over a stored plan sign-in", () => {
    const account = providerGroupAccount(entry({ openModelPreset: "kimi" }));
    expect(account.plan).toBe("Your key");
    expect(JSON.stringify(account)).not.toMatch(/subscription/i);
  });

  it("keeps a hand-built base-URL instance, or Pi and OpenCode, as before (D-05)", () => {
    const handBuilt = entry({
      auth: { status: "authenticated", type: "apiKey", label: "API key" },
    } as never);
    expect(providerGroupAccount(handBuilt)).toEqual({ plan: "API key", email: null });
    const pi = {
      ...entry({
        auth: {
          status: "authenticated",
          type: "subscription",
          label: "Pro subscription",
          email: "person@example.com",
        },
      } as never),
      driverKind: "pi",
    } as ProviderInstanceEntry;
    expect(providerGroupAccount(pi)).toEqual({
      plan: "Pro subscription",
      email: "pe••••on@example.com",
    });
  });
});

describe("ProviderGroupHeader", () => {
  const header = (value: ProviderInstanceEntry) =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(ProviderGroupHeader, { entry: value, usage: undefined }),
      ),
    );

  it("draws one route pill and no plan usage link for an open-model route", () => {
    const html = header(
      entry({
        openModelPreset: "deepseek",
        auth: { status: "authenticated", type: "subscription", label: "Your key" },
      } as never),
    );
    expect(html.match(/data-model-picker-group-plan=/g)).toHaveLength(1);
    expect(html).toContain('data-model-picker-group-plan="open-model"');
    expect(html.match(/Your key/g)).toHaveLength(1);
    expect(html).not.toMatch(/subscription|claude\.ai\/settings\/usage/i);
  });

  it("keeps a plan sign-in's pill and usage link (D-05)", () => {
    const html = header(entry({}));
    expect(html).toContain('data-model-picker-group-plan=""');
    expect(html).toContain("Max subscription");
    expect(html).toContain("claude.ai/settings/usage");
  });
});
