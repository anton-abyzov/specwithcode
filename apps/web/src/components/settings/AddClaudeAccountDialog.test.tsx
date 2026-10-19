// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";

const state = vi.hoisted(() => ({
  providers: [] as Array<Record<string, unknown>>,
  update: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) => (atom === "providers" ? state.providers : null),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => "providers",
    mutateProviderInstance: "update",
    refreshProviders: "refresh",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "update" ? state.update : state.refresh),
}));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useSettings")>()),
  usePrimarySettingsAvailable: () => true,
  useEnvironmentSettings: () => ({
    providerInstances: { codex_personal: { driver: "codex", config: {} } },
  }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: vi.fn() }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../ui/wizard", () => ({
  WizardPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WizardPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WizardFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  WizardHeader: ({ title, description }: { title: ReactNode; description: ReactNode }) => (
    <header>
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  ),
}));

import { AddClaudeAccountDialog } from "./AddClaudeAccountDialog";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.providers = [];
  state.update.mockReset().mockResolvedValue({ _tag: "Success" });
  state.refresh.mockReset().mockResolvedValue({ _tag: "Success" });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

async function render() {
  await act(async () =>
    root.render(
      <AddClaudeAccountDialog
        environmentId={EnvironmentId.make("m4")}
        environmentLabel="Studio Mac"
        onClose={() => {}}
      />,
    ),
  );
}

describe("AddClaudeAccountDialog", () => {
  it("adds a Claude instance in its own home with one create, not the whole map", async () => {
    await render();
    const input = container.querySelector("input")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(input, "Marketing");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("Continue")!.click());
    expect(state.update).toHaveBeenCalledWith({
      environmentId: "m4",
      input: {
        patch: {},
        providerInstanceMutation: {
          operation: "create",
          instanceId: "claudeAgent_marketing",
          instance: {
            driver: "claudeAgent",
            displayName: "Claude - Marketing",
            enabled: true,
            config: { enabled: true, homePath: "~/.claude-marketing" },
          },
        },
      },
    });
    expect(container.querySelector("code")?.textContent).toBe(
      "CLAUDE_CONFIG_DIR=~/.claude-marketing command claude auth login",
    );
    expect(container.textContent).toContain("Waiting for the sign-in");
    await act(async () => button("Check sign-in")!.click());
    expect(state.refresh).toHaveBeenCalledWith({
      environmentId: "m4",
      input: { instanceId: "claudeAgent_marketing" },
    });
  });

  it("says who signed in once the new instance reports it", async () => {
    await render();
    await act(async () => button("Continue")!.click());
    state.providers = [
      {
        instanceId: "claudeAgent_work",
        auth: { status: "authenticated", email: "team@company.example" },
      },
    ];
    await render();
    expect(container.textContent).toContain("Signed in as team@company.example");
    expect(button("Done")).toBeDefined();
  });
});
