// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@specweave-studio/contracts";

const LINK = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=STATE1";

const state = vi.hoisted(() => ({
  providers: [] as Array<Record<string, unknown>>,
  auth: null as Record<string, unknown> | null,
  authError: null as string | null,
  primary: "m4" as string,
  os: "darwin" as string,
  update: vi.fn(),
  refresh: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
  cancel: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: unknown) => (atom === "providers" ? state.providers : null),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => "providers",
    providerAuthState: () => "auth",
    mutateProviderInstance: "update",
    refreshProviders: "refresh",
    startProviderAuth: "start",
    completeProviderAuth: "complete",
    cancelProviderAuth: "cancel",
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: "update" | "refresh" | "start" | "complete" | "cancel") =>
    state[command],
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === null ? { data: null, error: null } : { data: state.auth, error: state.authError },
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  usePrimaryEnvironmentId: () => state.primary,
  useEnvironment: () => ({ serverConfig: { environment: { platform: { os: state.os } } } }),
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
vi.mock("../../hooks/useCopyToClipboard", () => ({
  writeTextToClipboard: (text: string) => state.copy(text),
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));
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

const idle = { phase: "idle", flowId: null, interaction: null, message: null };
const waiting = {
  phase: "waiting",
  flowId: "flow-1",
  message: "Complete sign-in to continue.",
  interaction: {
    type: "browser",
    id: "claude-sign-in",
    url: LINK,
    requiresConsent: false,
    acceptsCallback: true,
  },
};

let root: Root;
let container: HTMLDivElement;
const openTab = vi.fn();
beforeEach(() => {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  state.providers = [];
  state.auth = idle;
  state.authError = null;
  state.primary = "m4";
  state.os = "darwin";
  for (const command of [state.update, state.refresh, state.start, state.complete, state.cancel])
    command.mockReset().mockResolvedValue({ _tag: "Success", value: { flowId: "flow-1" } });
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(undefined);
  openTab.mockReset();
  vi.stubGlobal("open", openTab);
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

async function render() {
  await act(async () =>
    root.render(
      <AddClaudeAccountDialog
        environmentId={EnvironmentId.make("m4")}
        environmentLabel="Mac mini"
        onClose={() => {}}
      />,
    ),
  );
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const signedOut = (instanceId: string) => ({ instanceId, auth: { status: "unauthenticated" } });

/** Past the name step, on the sign-in step of the new "Work" account, listed by its machine. */
async function onSignInStep() {
  await render();
  await act(async () => button("Continue")!.click());
  state.providers = [signedOut("claudeAgent_work")];
  await render();
}

const onThisMachine = () => {
  (window as { desktopBridge?: unknown }).desktopBridge = {};
};

describe("AddClaudeAccountDialog", () => {
  it("adds a Claude instance in its own home with one create, not the whole map", async () => {
    await render();
    await type(container.querySelector("input")!, "Marketing");
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
    // The machine has not listed the new account yet: nothing to sign in to.
    expect(button("Sign in with Claude")?.disabled).toBe(true);
    state.providers = [signedOut("claudeAgent_marketing")];
    await render();
    // One button signs in; the terminal command is there for those who want it.
    expect(button("Sign in with Claude")?.disabled).toBe(false);
    expect(container.textContent).toContain("No terminal needed.");
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("details code")?.textContent).toBe(
      "CLAUDE_CONFIG_DIR=~/.claude-marketing command claude auth login",
    );
    expect(container.textContent).toContain(
      "The Claude desktop app has its own sign-in, and it does not count here.",
    );
    expect(container.textContent).not.toContain("WSL");
    await act(async () => button("Check sign-in")!.click());
    expect(state.refresh).toHaveBeenCalledWith({
      environmentId: "m4",
      input: { instanceId: "claudeAgent_marketing" },
    });
  });

  it("on the app's own machine lets Claude Code open the page: nothing to type", async () => {
    onThisMachine();
    await onSignInStep();
    await act(async () => button("Sign in with Claude")!.click());
    expect(state.start).toHaveBeenCalledWith({
      environmentId: "m4",
      input: { instanceId: "claudeAgent_work", callbackMode: "server" },
    });
    state.auth = waiting;
    await render();
    expect(container.textContent).toContain("Finish in your browser");
    // Claude Code opened the page there; the app opens no second one.
    expect(openTab).not.toHaveBeenCalled();
    expect(state.openExternal).not.toHaveBeenCalled();
    await act(async () => button("Open the page again")!.click());
    expect(state.openExternal).toHaveBeenCalledWith(LINK);
    await act(async () => button("Copy the link")!.click());
    expect(state.copy).toHaveBeenCalledWith(LINK);
    expect(button("Link copied")).toBeDefined();
  });

  it("from a browser on another device opens the page here and takes the code", async () => {
    const tab = { location: { href: "" }, opener: {} as unknown, close: vi.fn() };
    openTab.mockReturnValue(tab);
    await onSignInStep();
    await act(async () => button("Sign in with Claude")!.click());
    // The tab is taken during the click, before the machine answers.
    expect(openTab).toHaveBeenCalledWith("", "_blank");
    expect(tab.opener).toBeNull();
    expect(state.start).toHaveBeenCalledWith({
      environmentId: "m4",
      input: { instanceId: "claudeAgent_work", callbackMode: "client" },
    });
    state.auth = waiting;
    await render();
    expect(tab.location.href).toBe(LINK);

    const code = container.querySelector<HTMLInputElement>(
      'input[aria-label="Code from the page"]',
    )!;
    await type(code, "abc123");
    await act(async () => code.form!.requestSubmit());
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "That is not the whole code.",
    );
    expect(state.complete).not.toHaveBeenCalled();

    await type(code, " abc123#STATE1 ");
    await act(async () => code.form!.requestSubmit());
    expect(state.complete).toHaveBeenCalledWith({
      environmentId: "m4",
      input: { instanceId: "claudeAgent_work", flowId: "flow-1", callbackUrl: "abc123#STATE1" },
    });
    expect(code.value).toBe("");
    // Claude Code says nothing until it is done with the code, so the app does.
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Checking…");
    expect(code.disabled).toBe(true);

    await act(async () => button("Cancel")!.click());
    expect(state.cancel).toHaveBeenCalledWith({
      environmentId: "m4",
      input: { instanceId: "claudeAgent_work", flowId: "flow-1" },
    });
  });

  it("in the app, for another machine, opens the page on this device once", async () => {
    onThisMachine();
    state.primary = "this-laptop";
    await onSignInStep();
    await act(async () => button("Sign in with Claude")!.click());
    expect(state.start.mock.calls[0]![0].input.callbackMode).toBe("client");
    expect(openTab).not.toHaveBeenCalled();
    state.auth = waiting;
    await render();
    await render();
    expect(state.openExternal).toHaveBeenCalledTimes(1);
    expect(state.openExternal).toHaveBeenCalledWith(LINK);
  });

  it("closes the tab it took when the sign-in cannot start", async () => {
    const tab = { location: { href: "" }, opener: {} as unknown, close: vi.fn() };
    openTab.mockReturnValue(tab);
    state.start.mockResolvedValue({ _tag: "Failure", cause: new Error("no") });
    await onSignInStep();
    await act(async () => button("Sign in with Claude")!.click());
    expect(tab.close).toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it("stops the sign-in on the machine when the dialog closes", async () => {
    await onSignInStep();
    state.auth = waiting;
    await render();
    await act(async () => root.unmount());
    expect(state.cancel).toHaveBeenCalledWith({
      environmentId: "m4",
      input: { instanceId: "claudeAgent_work", flowId: "flow-1" },
    });
    root = createRoot(container);
  });

  it("stops a sign-in the machine started after the dialog had closed", async () => {
    let answer!: (result: unknown) => void;
    state.start.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await onSignInStep();
    await act(async () => button("Sign in with Claude")!.click());
    await act(async () => root.unmount());
    expect(state.cancel).not.toHaveBeenCalled();
    await act(async () => answer({ _tag: "Success", value: { flowId: "flow-9" } }));
    expect(state.cancel).toHaveBeenCalledWith({
      environmentId: "m4",
      input: { instanceId: "claudeAgent_work", flowId: "flow-9" },
    });
    root = createRoot(container);
  });

  it("keeps the tab taken for Try again while the last failure still shows", async () => {
    const tab = { location: { href: "" }, opener: {} as unknown, close: vi.fn() };
    openTab.mockReturnValue(tab);
    await onSignInStep();
    state.auth = { ...idle, phase: "failed", message: "Claude did not accept the sign-in." };
    await render();
    await act(async () => button("Try again")!.click());
    await render();
    expect(tab.close).not.toHaveBeenCalled();
    state.auth = waiting;
    await render();
    expect(tab.location.href).toBe(LINK);
  });

  it("closes the tab it took when the sign-in ends with no page to show", async () => {
    const tab = { location: { href: "" }, opener: {} as unknown, close: vi.fn() };
    openTab.mockReturnValue(tab);
    await onSignInStep();
    await act(async () => button("Sign in with Claude")!.click());
    expect(tab.close).not.toHaveBeenCalled();
    // Claude Code was signed in already and ended without a link.
    state.auth = { ...idle, phase: "succeeded" };
    await render();
    expect(tab.close).toHaveBeenCalled();
  });

  it("counts a sign-in the machine took, even before it can read the account", async () => {
    await onSignInStep();
    state.auth = { ...idle, phase: "succeeded" };
    state.providers = [{ instanceId: "claudeAgent_work", auth: { status: "unknown" } }];
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Signed in.");
    expect(button("Sign in with Claude")).toBeUndefined();
    // Signed out again later: the old result no longer counts.
    state.providers = [signedOut("claudeAgent_work")];
    await render();
    expect(button("Sign in with Claude")).toBeDefined();
  });

  it("gives the reason and Try again when the sign-in fails", async () => {
    await onSignInStep();
    state.auth = {
      ...idle,
      phase: "failed",
      message: "Claude did not accept the sign-in. Start again to get a new page.",
    };
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Claude did not accept the sign-in. Start again to get a new page.",
    );
    await act(async () => button("Try again")!.click());
    expect(state.start).toHaveBeenCalledTimes(1);
  });

  it("shows Checking while the machine reads the account", async () => {
    await onSignInStep();
    state.auth = { ...idle, phase: "verifying", flowId: "flow-1" };
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Checking…");
    expect(button("Sign in with Claude")).toBeUndefined();
    expect(button("Cancel")).toBeUndefined();
  });

  it("says who signed in and on what plan once the new instance reports it", async () => {
    await onSignInStep();
    state.auth = { ...idle, phase: "succeeded" };
    state.providers = [
      {
        instanceId: "claudeAgent_work",
        auth: {
          status: "authenticated",
          email: "team@company.example",
          label: "Claude Max Subscription",
        },
      },
    ];
    await render();
    expect(container.textContent).toContain("Signed in as team@company.example.");
    expect(container.textContent).toContain("Plan: Claude Max Subscription.");
    expect(container.querySelector("details")).toBeNull();
    expect(button("Done")).toBeDefined();
  });

  it("tells a Windows machine's user about WSL and gives the PowerShell command", async () => {
    state.os = "windows";
    await onSignInStep();
    expect(container.textContent).toContain(
      "A sign-in inside WSL or under another Windows user does not count either.",
    );
    expect(container.querySelector("details code")?.textContent).toBe(
      '$env:CLAUDE_CONFIG_DIR = "$HOME\\.claude-work"; claude auth login',
    );
  });

  it("falls back to the command on a machine that cannot run the sign-in", async () => {
    state.auth = null;
    state.authError = "This provider does not support sign-in in SpecWithCode.";
    await onSignInStep();
    expect(button("Sign in with Claude")).toBeUndefined();
    expect(container.querySelector("details")?.open).toBe(true);
    expect(container.textContent).toContain(
      "Run the command below once in a terminal on Mac mini.",
    );
  });
});
