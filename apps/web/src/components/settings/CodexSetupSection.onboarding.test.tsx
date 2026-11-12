// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The first-run row of a Codex CLI's own sign-in talks to no machine.
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => null,
  useEnvironmentHttpBaseUrl: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null }),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../localApi", () => ({ ensureLocalApi: vi.fn() }));
vi.mock("./ChatGptUsageButton", () => ({ ChatGptUsageButton: () => null }));
vi.mock("./ChatGptAccountPicker", () => ({ ChatGptAccountPicker: () => null }));
vi.mock("./AddCodexAccountDialog", () => ({ AddCodexAccountDialog: () => null }));
vi.mock("./settingsLayout", () => ({ SettingsRow: () => null }));
vi.mock("./RedactedSensitiveText", () => ({
  RedactedSensitiveText: ({ value }: { value: string }) => <span>{value}</span>,
}));

import { CodexSetupSection } from "./CodexSetupSection";

const codex = (patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated", email: "ada@example.com" },
  checkedAt: "2026-11-12T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...patch,
});

let root: Root;
let container: HTMLDivElement;
const onModeChange = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const show = (provider: ServerProvider | undefined) =>
  act(async () =>
    root.render(
      <CodexSetupSection
        presentation="onboarding"
        environmentId={EnvironmentId.make("this-computer")}
        instanceId={ProviderInstanceId.make("codex")}
        provider={provider}
        mode="existing"
        enabled
        onModeChange={onModeChange}
        onboardingMenu={<button aria-label="More for Codex">…</button>}
        onboardingSignedOutFooter={<code data-command>codex login</code>}
      />,
    ),
  );
const text = () => container.textContent ?? "";
const buttons = () => [...container.querySelectorAll("button")].map((node) => node.textContent);
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label)!;

describe("the Codex row at first run, with the Codex CLI's own sign-in", () => {
  it("is Ready with the account, says the existing sign-in is used, and asks for nothing", async () => {
    await show(codex());
    expect(container.querySelector("h3")?.textContent).toBe("Codex");
    expect(text()).toContain("Uses your ChatGPT plan");
    expect(text()).toContain("Signed in as ada@example.com. The existing Codex sign-in is used.");
    expect(text()).toContain("Ready");
    // A quiet action and the menu, and no sign-in button.
    expect(buttons()).toEqual(["Use another account", "…"]);
    expect(container.querySelector("[data-command]")).toBeNull();
    expect(text()).not.toContain("Sign in with ChatGPT");
  });

  it("says the existing sign-in is used when the CLI names no account", async () => {
    await show(codex({ auth: { status: "authenticated" } }));
    expect(text()).toContain("The existing Codex sign-in is used.");
    expect(text()).not.toContain("Signed in as");
  });

  it("moves to the app's ChatGPT sign-in on Use another account", async () => {
    await show(codex());
    await act(async () => button("Use another account").click());
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith("managed");
  });

  it("has one button, Sign in with ChatGPT, when the CLI is not signed in", async () => {
    await show(codex({ status: "error", auth: { status: "unauthenticated" } }));
    expect(buttons()).toEqual(["Sign in with ChatGPT"]);
    expect(text()).not.toContain("Use existing CLI");
    // The CLI's own command is there for those who want it.
    expect(container.querySelector("[data-command]")?.textContent).toBe("codex login");
    await act(async () => button("Sign in with ChatGPT").click());
    expect(onModeChange).toHaveBeenCalledExactlyOnceWith("managed");
  });

  it("offers the same one button when no Codex CLI is installed, with no command", async () => {
    await show(codex({ installed: false, status: "error", auth: { status: "unknown" } }));
    expect(buttons()).toEqual(["Sign in with ChatGPT"]);
    expect(container.querySelector("[data-command]")).toBeNull();
  });

  it("says Checking, with no button, until the machine has listed Codex", async () => {
    await show(undefined);
    expect(text()).toContain("Checking…");
    expect(buttons()).toEqual([]);
  });
});
