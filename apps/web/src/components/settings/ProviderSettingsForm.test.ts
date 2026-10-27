// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, REDACTED_SECRET_MARKER } from "@specweave-studio/contracts";

import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  ProviderSettingsForm,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("offers Muse Code configuration with native Wonder Full guidance", () => {
    const muse = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("muse")];
    expect(muse?.label).toBe("Muse Code");
    expect(muse?.hasDefaultInstance).toBe(false);
    const fields = deriveProviderSettingsFields(muse!);
    expect(fields.map((field) => field.key)).toEqual(["binaryPath"]);
    expect(fields[0]?.description).toContain("Power or Maximum Usage");
    expect(muse?.environmentFields?.[0]?.description).toContain("pay-as-you-go");
  });
  it("derives visible provider config fields from the client definition schema", () => {
    const codex = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("codex")];

    expect(codex).toBeDefined();
    expect(deriveProviderSettingsFields(codex!).map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "shadowHomePath",
      "launchArgs",
    ]);
  });

  it("sources labels and descriptions from schema annotations", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverPassword = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverPassword",
    );

    expect(serverPassword).toMatchObject({
      label: "Server password",
      description: "Stored in plain text on disk.",
      control: "password",
    });
  });

  it("uses a dedicated environment field instead of legacy Cursor CLI settings", () => {
    const cursor = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("cursor")];

    expect(cursor).toBeDefined();
    expect(deriveProviderSettingsFields(cursor!)).toEqual([]);
    expect(cursor?.environmentFields).toEqual([
      {
        name: "CURSOR_API_KEY",
        label: "Cursor API key",
        description: "Optional. Overrides browser sign-in for this provider.",
        placeholder: "Paste API key",
        sensitive: true,
      },
    ]);
  });

  it("exposes ACP Registry as an instance-only configurable driver", () => {
    const acpRegistry = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("acpRegistry")];

    expect(acpRegistry).toBeDefined();
    expect(acpRegistry?.hasDefaultInstance).toBe(false);
    expect(deriveProviderSettingsFields(acpRegistry!).map((field) => field.key)).toEqual([
      "source",
      "agentId",
      "commandPath",
      "authMethodId",
    ]);
  });

  it("shows the local executable without registry identity or authentication fields", () => {
    const acpRegistry = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("acpRegistry")];
    expect(
      deriveProviderSettingsFields(acpRegistry!, { source: "local" }).map((field) => field.key),
    ).toEqual(["source", "commandPath"]);
  });

  it("derives a select control with its choices for the Antigravity sign-in method", () => {
    const antigravity = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("antigravity")];
    expect(antigravity).toBeDefined();

    const fields = deriveProviderSettingsFields(antigravity!);
    expect(fields.map((field) => field.key)).toEqual([
      "authMethod",
      "apiKey",
      "gcpProject",
      "gcpLocation",
      "binaryPath",
    ]);
    const authMethod = fields.find((field) => field.key === "authMethod");
    expect(authMethod).toMatchObject({ control: "select", clearWhenEmpty: "omit" });
    expect(authMethod?.options?.map((option) => option.value)).toEqual([
      "oauth-personal",
      "oauth-business",
      "gemini-api-key",
      "agent-platform",
    ]);
    expect(fields.find((field) => field.key === "apiKey")?.control).toBe("password");
  });

  it("shows the auto-compaction threshold for Claude providers", () => {
    const claude = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("claudeAgent")];
    expect(claude).toBeDefined();

    const fields = deriveProviderSettingsFields(claude!);
    expect(fields.map((field) => field.key)).toEqual([
      "binaryPath",
      "homePath",
      "autoCompactWindow",
      "compactBeforeCacheExpires",
      "launchArgs",
    ]);
    expect(fields.find((field) => field.key === "compactBeforeCacheExpires")).toMatchObject({
      control: "switch",
      defaultBooleanValue: false,
    });
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")];
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits false boolean fields when clearWhenEmpty is omit", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: true },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: false,
      },
      false,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("omits true boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, experimental: false },
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      true,
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("preserves false boolean fields when clearWhenEmpty is persist", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "persist",
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });

  it("shows a saved provider password as stored instead of echoing the marker", () => {
    const antigravity = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("antigravity")]!;
    const render = (value: unknown, variant: "card" | "settings") =>
      renderToStaticMarkup(
        createElement(ProviderSettingsForm, {
          definition: antigravity,
          value,
          idPrefix: "gemini",
          variant,
          onChange: () => {},
        }),
      );
    for (const variant of ["card", "settings"] as const) {
      const stored = render({ apiKey: REDACTED_SECRET_MARKER }, variant);
      expect(stored).not.toContain(REDACTED_SECRET_MARKER);
      expect(stored).toContain("Stored secret - enter a new value to replace");
      expect(stored).toContain('aria-label="Clear API key"');
      const empty = render({}, variant);
      expect(empty).not.toContain("Stored secret");
      expect(empty).not.toContain("Clear API key");
    }
  });

  it("says why a saved password disappeared when its server moved to another origin", async () => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const opencode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("opencode")]!;
    const password = deriveProviderSettingsFields(opencode).find(
      (field) => field.control === "password",
    )!;
    const host = document.createElement("div");
    const root = createRoot(host);
    const show = (value: unknown) =>
      act(async () =>
        root.render(
          createElement(ProviderSettingsForm, {
            definition: opencode,
            value,
            idPrefix: "oc",
            variant: "settings",
            onChange: () => {},
          }),
        ),
      );
    const note = `${password.label} cleared because the server address changed`;
    const saved = { serverUrl: "http://127.0.0.1:4096", serverPassword: REDACTED_SECRET_MARKER };

    // Cleared on the same server (by hand or elsewhere): no note.
    await show(saved);
    await show({ serverUrl: "http://127.0.0.1:4096/api" });
    expect(host.textContent).not.toContain(note);

    // The address moves while the password is saved; the server drops it.
    await show(saved);
    await show({ ...saved, serverUrl: "https://other.example" });
    expect(host.textContent).not.toContain(note);
    await show({ serverUrl: "https://other.example" });
    expect(host.textContent).toContain(note);

    // Typing a new password removes the note.
    await show({ serverUrl: "https://other.example", serverPassword: "typed" });
    expect(host.textContent).not.toContain(note);
    await act(async () => root.unmount());
  });
});
