// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@specweave-studio/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  serverConfig: null as unknown,
  foundPath: null as string | null,
  allowed: true,
  lockedBy: null as string | null,
  held: false,
  refresh: vi.fn(),
  claude: vi.fn(),
  copy: vi.fn(),
  panel: {
    session: null as { agentName: string } | null,
    canOperateTerminal: true,
    available: true,
    open: vi.fn(),
    close: vi.fn(),
    checkingInstance: null as string | null,
    endedInstance: null as string | null,
    stopChecking: vi.fn(),
  },
  panelOptions: vi.fn(),
  detached: { until: null as number | null, forget: vi.fn() },
}));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => mocks.serverConfig,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: { configValueAtom: () => "config", refreshProviders: "refresh" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.refresh }));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: mocks.copy }));
vi.mock("../onboarding/AgentSetupPanel", () => ({
  AGENT_CHECK_TIMEOUT_MS: 15_000,
  agentSetupPanelKey: () => "panel",
  useDetachedInstall: () => mocks.detached,
  useAgentSetupPanel: (options: unknown) => {
    mocks.panelOptions(options);
    return mocks.panel;
  },
  AgentSetupPanel: ({ session }: { session: { agentName: string } }) => (
    <section data-testid="setup-panel">{session.agentName}</section>
  ),
}));
vi.mock("./ClaudeSignIn", () => ({
  ClaudeSignIn: (props: Record<string, unknown>) => {
    mocks.claude(props);
    return (
      <section data-testid="claude-sign-in">
        <button>Sign in with Claude</button>
      </section>
    );
  },
}));
vi.mock("./FoundAgents", () => ({ useFoundAgentPath: () => mocks.foundPath }));
vi.mock("./settingsLayout", () => ({
  TeamRulesLabel: ({ children }: { children: string }) => <span data-team-rules>{children}</span>,
}));
vi.mock("../onboarding/WizardFrame", () => ({
  useHeldFor: (active: boolean) => active && mocks.held,
}));
vi.mock("../../teamRules/useTeamRules", () => ({
  useTeamRules: () => ({ summary: undefined, state: "rules", setBy: null }),
}));
vi.mock("../../teamRules/teamRulesView", () => ({
  teamRulesProviderLock: () => mocks.lockedBy,
}));
vi.mock("@specweave-studio/shared/teamRules", async (original) => ({
  ...(await original<typeof import("@specweave-studio/shared/teamRules")>()),
  teamRulesProviderAllowed: () => mocks.allowed,
}));
vi.mock("./RedactedSensitiveText", () => ({
  RedactedSensitiveText: ({ value }: { value: string }) => <span data-redacted>{value}</span>,
}));

import { ProviderStatusRow } from "./ProviderStatusRow";

const environmentId = EnvironmentId.make("this-computer");
const agent = (driver: string, patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.4.2",
  status: "ready",
  auth: { status: "authenticated", email: "ada@example.com", label: "Pro" },
  checkedAt: "2026-11-12T00:00:00.000Z",
  models: [{ slug: "one", name: "One", isCustom: false }] as never,
  slashCommands: [],
  skills: [],
  ...patch,
});
const signedOut = { status: "error", auth: { status: "unauthenticated" } } as const;
const missing = { installed: false, status: "error", auth: { status: "unknown" } } as const;

let root: Root;
let container: HTMLDivElement;
const onTurnOn = vi.fn();
const onAcceptUrlAuth = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.serverConfig = {
    cwd: "/work",
    keybindings: [],
    environment: { platform: { os: "darwin" } },
    settings: { providerInstances: {}, providers: {} },
  };
  mocks.foundPath = null;
  mocks.allowed = true;
  mocks.lockedBy = null;
  mocks.held = false;
  mocks.detached.until = null;
  mocks.refresh.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.copy.mockResolvedValue(undefined);
  Object.assign(mocks.panel, {
    session: null,
    available: true,
    checkingInstance: null,
    endedInstance: null,
  });
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

type RowProps = Partial<Parameters<typeof ProviderStatusRow>[0]>;
const show = (provider: ServerProvider | undefined, props: RowProps = {}) => {
  const driver = provider?.driver ?? ProviderDriverKind.make("grok");
  const instance = { driver, enabled: true } as ProviderInstanceConfig;
  return act(async () =>
    root.render(
      <ProviderStatusRow
        environmentId={environmentId}
        environmentLabel="Office Mac"
        instanceId={provider?.instanceId ?? ProviderInstanceId.make("grok")}
        instance={instance}
        provider={provider}
        enabled
        readOnly={false}
        name="Grok"
        onTurnOn={onTurnOn}
        onAcceptUrlAuth={onAcceptUrlAuth}
        {...props}
      />,
    ),
  );
};
const text = () => container.textContent ?? "";
const buttons = () => [...container.querySelectorAll("button")];
const button = (label: string) => buttons().find((element) => element.textContent === label);
const row = () => container.querySelector<HTMLElement>("[data-agent-status-row]")!;
const facts = () =>
  Object.fromEntries(
    [...container.querySelectorAll("dt")].map((term) => [
      term.textContent,
      term.nextElementSibling?.textContent,
    ]),
  );
const press = (label: string) => act(async () => button(label)!.click());

describe("the selected agent's status row", () => {
  it("says a ready agent is signed in, as whom, on which machine, and has no button", async () => {
    mocks.foundPath = "/opt/homebrew/bin/grok";
    await show(agent("grok"));
    expect(row().dataset.agentStatusRow).toBe("grok");
    expect(row().dataset.agentState).toBe("ready");
    expect(row().getAttribute("aria-label")).toBe("Agent status");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Signed in");
    expect(text()).toContain("Signed in as ada@example.com.");
    expect(text()).toContain("Plan: Pro.");
    expect(container.querySelector("[data-redacted]")?.textContent).toBe("ada@example.com");
    expect(facts()).toEqual({
      "Runs on": "Office Mac",
      Version: "v1.4.2",
      Command: "/opt/homebrew/bin/grok",
    });
    expect(buttons()).toEqual([]);
  });

  it("names the account by its login when the agent reports no email", async () => {
    await show(agent("grok", { auth: { status: "authenticated", login: "work-account" } }));
    expect(text()).toContain("Signed in as work-account.");
    expect(container.querySelector("[data-redacted]")).toBeNull();
  });

  it("says why a signed-in agent is not ready, in the machine's words", async () => {
    await show(agent("grok", { status: "error", message: "The probe failed: not a symlink." }));
    expect(row().dataset.agentState).toBe("attention");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "The probe failed: not a symlink.",
    );
    expect(button("Check again")).toBeDefined();
  });

  it("names the plan by its kind when the agent gives no plan name", async () => {
    await show(agent("grok", { auth: { status: "authenticated", type: "apiKey" } }));
    expect(text()).toContain("Plan: apiKey.");
  });

  it("shows the file that was found when the saved command is only a name", async () => {
    mocks.foundPath = "/opt/homebrew/bin/grok";
    const provider = agent("grok");
    await show(provider, {
      instance: {
        driver: provider.driver,
        enabled: true,
        config: { binaryPath: "grok" },
      } as ProviderInstanceConfig,
    });
    expect(facts().Command).toBe("/opt/homebrew/bin/grok");
  });

  it("does not show the usual entry's file for a second entry of the same agent", async () => {
    mocks.foundPath = "/opt/homebrew/bin/grok";
    await show(agent("grok", { instanceId: ProviderInstanceId.make("grok_work") }));
    expect(facts().Command).toBeUndefined();
  });

  it("offers Check again to a ready agent that has listed no models", async () => {
    await show(agent("grok", { models: [] }));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Signed in");
    expect(button("Check again")).toBeDefined();
  });

  it("shows the command saved for the agent in place of the one that was found", async () => {
    mocks.foundPath = "/opt/homebrew/bin/grok";
    const provider = agent("grok");
    await show(provider, {
      instance: {
        driver: provider.driver,
        enabled: true,
        config: { binaryPath: " /Users/ada/bin/grok " },
      } as ProviderInstanceConfig,
    });
    expect(facts().Command).toBe("/Users/ada/bin/grok");
  });

  it("leaves the version and the command out when the machine has not told them", async () => {
    await show(agent("grok", { version: null }));
    expect(facts()).toEqual({ "Runs on": "Office Mac" });
  });

  it("offers Turn on for an agent that is off", async () => {
    await show(agent("grok", { enabled: false }), { enabled: false });
    expect(row().dataset.agentState).toBe("off");
    expect(text()).toContain("Turn it on to use it in chat.");
    await press("Turn on");
    expect(onTurnOn).toHaveBeenCalledOnce();
    await show(agent("grok", { enabled: false }), { enabled: false, readOnly: true });
    expect(buttons()).toEqual([]);
  });

  it("leaves Turn on out where the team's rules do not allow the agent, and names who set them", async () => {
    mocks.allowed = false;
    mocks.lockedBy = "Set by Acme";
    await show(agent("grok", { enabled: false }), { enabled: false });
    expect(row().dataset.agentState).toBe("off");
    expect(buttons()).toEqual([]);
    expect(container.querySelector("[data-team-rules]")?.textContent).toBe("Set by Acme");
  });

  it("stops saying Checking for good: after a while it offers Check again", async () => {
    await show(undefined);
    expect(buttons()).toEqual([]);
    mocks.held = true;
    await show(undefined, { name: "Grok again" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Checking…");
    await press("Check again");
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId: ProviderInstanceId.make("grok") },
    });
  });

  it("gives the machine's words and Check again where the app has no sign-in to start", async () => {
    await show(
      agent("some-new-agent", { ...signedOut, message: "Sign in from the agent's own app." }),
      { name: "New agent" },
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Not signed in");
    expect(text()).toContain("Sign in from the agent's own app.");
    expect(buttons().map((element) => element.textContent)).toEqual(["Check again"]);
  });

  it("lets a connection that cannot change agents read an agent again", async () => {
    await show(agent("grok", { status: "error", message: "The probe failed." }), {
      readOnly: true,
    });
    expect(buttons().map((element) => element.textContent)).toEqual(["Check again"]);
  });

  it("keeps the agent's own sign-in under the row while the machine reads it again", async () => {
    const setupBlock: ReactNode = <section data-testid="own-setup" />;
    await show(agent("codex", { status: "warning", auth: { status: "unknown" } }), {
      name: "Codex",
      setupBlock,
    });
    expect(container.querySelector('[data-testid="own-setup"]')).not.toBeNull();
  });

  it("takes Claude's sign-in away when Claude turns out not to be installed", async () => {
    await show(agent("claudeAgent", signedOut), { name: "Claude" });
    await show(agent("claudeAgent", missing), { name: "Claude" });
    expect(container.querySelector('[data-testid="claude-sign-in"]')).toBeNull();
  });

  it("signs an agent in from here: one button named for the account, its command under it", async () => {
    await show(agent("grok", signedOut));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Not signed in");
    expect(text()).toContain("grok login");
    await press("Sign in with Grok");
    expect(mocks.panel.open).toHaveBeenCalledExactlyOnceWith({
      agent: "grok",
      agentName: "Grok",
      providerInstanceId: ProviderInstanceId.make("grok"),
      command: "grok login",
      purpose: "signIn",
    });
  });

  it("leaves the machine's words about running a command out of the row", async () => {
    await show(agent("grok", { ...signedOut, message: "Not logged in. Run `grok login`." }));
    expect(text()).not.toContain("Not logged in.");
  });

  it("holds the sign-in button while the panel is busy or cannot open", async () => {
    mocks.panel.available = false;
    await show(agent("grok", signedOut));
    expect(button("Sign in with Grok")!.disabled).toBe(true);
  });

  it("shows the panel a sign-in runs in", async () => {
    mocks.panel.session = { agentName: "Grok" };
    await show(agent("grok", signedOut));
    expect(container.querySelector('[data-testid="setup-panel"]')?.textContent).toBe("Grok");
    expect(button("Sign in with Grok")!.disabled).toBe(true);
  });

  it("says so when the sign-in ended and the agent is still signed out", async () => {
    mocks.panel.endedInstance = "grok";
    await show(agent("grok", signedOut));
    expect(text()).toContain("The sign-in ended before Grok was signed in. Try again.");
    mocks.panel.endedInstance = "grok";
    mocks.panel.checkingInstance = "grok";
    await show(agent("grok", { ...signedOut, checkedAt: "2026-11-12T00:00:01.000Z" }));
    expect(text()).not.toContain("The sign-in ended before");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Checking…");
    expect(buttons()).toEqual([]);
  });

  it("signs Claude in with Claude's own sign-in, not a terminal", async () => {
    await show(agent("claudeAgent", signedOut), { name: "Claude" });
    expect(container.querySelector('[data-testid="claude-sign-in"]')).not.toBeNull();
    expect(mocks.claude).toHaveBeenLastCalledWith(
      expect.objectContaining({
        environmentId,
        environmentLabel: "Office Mac",
        instanceId: ProviderInstanceId.make("claudeAgent"),
        os: "darwin",
        command: "claude auth login",
        readOnly: false,
      }),
    );
    expect(buttons().map((element) => element.textContent)).toEqual(["Sign in with Claude"]);
  });

  it("keeps Claude's sign-in on screen while the machine reads Claude again", async () => {
    await show(agent("claudeAgent", signedOut), { name: "Claude" });
    await show(agent("claudeAgent", { status: "warning", auth: { status: "unknown" } }), {
      name: "Claude",
    });
    expect(container.querySelector('[data-testid="claude-sign-in"]')).not.toBeNull();
    await show(agent("claudeAgent"), { name: "Claude" });
    expect(container.querySelector('[data-testid="claude-sign-in"]')).toBeNull();
  });

  it("shows the agent's own sign-in from Setup in place of a button", async () => {
    const setupBlock: ReactNode = <section data-testid="own-setup">Sign in with ChatGPT</section>;
    await show(agent("codex", signedOut), { name: "Codex", setupBlock });
    expect(container.querySelector('[data-testid="own-setup"]')).not.toBeNull();
    expect(buttons()).toEqual([]);
    expect(text()).not.toContain("codex login");
  });

  it("offers nothing to press to a connection that cannot change agents", async () => {
    const setupBlock: ReactNode = <section data-testid="own-setup" />;
    await show(agent("grok", signedOut), { readOnly: true, setupBlock });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Not signed in");
    expect(buttons()).toEqual([]);
    expect(container.querySelector('[data-testid="own-setup"]')).toBeNull();
    expect(text()).not.toContain("grok login");
  });

  it("installs an agent the app can install, in the panel", async () => {
    await show(agent("codex", missing), { name: "Codex" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Not installed");
    await press("Install");
    expect(mocks.panel.open).toHaveBeenCalledExactlyOnceWith({
      agent: "codex",
      agentName: "Codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      purpose: "install",
    });
  });

  it("reads the machine again after an install, with no second Install meanwhile", async () => {
    let answer: (value: unknown) => void = () => {};
    mocks.refresh.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await show(agent("codex", missing), { name: "Codex" });
    const options = mocks.panelOptions.mock.lastCall![0] as { onInstallClosed: () => void };
    await act(async () => options.onInstallClosed());
    expect(mocks.refresh).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId: ProviderInstanceId.make("codex"), fresh: true },
    });
    expect(button("Install")).toBeUndefined();
    await act(async () => answer({ _tag: "Success", value: undefined }));
    expect(button("Install")).toBeDefined();
  });

  it("offers no second Install while an install it left running is still going", async () => {
    mocks.detached.until = Date.now() + 600_000;
    await show(agent("codex", missing), { name: "Codex" });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Checking…");
    expect(button("Install")).toBeUndefined();
    expect(mocks.detached.forget).not.toHaveBeenCalled();
  });

  it("stops waiting for an install left running that never lands", async () => {
    vi.useFakeTimers();
    try {
      mocks.detached.until = Date.now() + 600_000;
      await show(agent("codex", missing), { name: "Codex" });
      await act(async () => vi.advanceTimersByTime(5_000));
      expect(mocks.refresh).toHaveBeenCalledWith({
        environmentId,
        input: { instanceId: ProviderInstanceId.make("codex") },
      });
      expect(mocks.detached.forget).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(600_000));
      expect(mocks.detached.forget).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("forgets an install left running once the agent is there", async () => {
    mocks.detached.until = Date.now() + 600_000;
    await show(agent("codex", signedOut), { name: "Codex" });
    expect(mocks.detached.forget).toHaveBeenCalledOnce();
  });

  it("shows the agent's own install from Setup when it has one", async () => {
    const setupBlock: ReactNode = <section data-testid="own-setup">Install Antigravity</section>;
    await show(
      agent("antigravity", {
        ...missing,
        setup: { canAuthenticate: true, canInstall: true },
      } as Partial<ServerProvider>),
      { name: "Antigravity", setupBlock },
    );
    expect(container.querySelector('[data-testid="own-setup"]')).not.toBeNull();
    expect(button("Install")).toBeUndefined();
  });

  it("offers Check again for an agent it cannot install", async () => {
    await show(agent("grok", missing));
    await press("Check again");
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId: ProviderInstanceId.make("grok") },
    });
  });

  it("keeps the last sign-in it read when a check gives no answer, and reads again on request", async () => {
    let answer!: (value: unknown) => void;
    mocks.refresh.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await show(
      agent("grok", {
        status: "warning",
        auth: { status: "unknown" },
        lastKnownAuth: { status: "authenticated", email: "ada@example.com" },
        message: "Could not check Grok: no answer in 15 seconds.",
      }),
    );
    expect(row().dataset.agentState).toBe("noAnswer");
    expect(text()).toContain("Could not check Grok: no answer in 15 seconds.");
    expect(text()).toContain("Last time it was signed in as ada@example.com.");
    await press("Check again");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Checking…");
    expect(row().dataset.agentState).toBe("checking");
    expect(buttons()).toEqual([]);
    await act(async () => answer({ _tag: "Success", value: undefined }));
    expect(button("Check again")).toBeDefined();
  });

  it("opens a sign-in page the agent asks for and tells the caller", async () => {
    const action = {
      elicitationId: "sign-in-1",
      url: "https://example.com/device",
      message: "Open this page.",
    };
    await show(
      agent("grok", {
        ...signedOut,
        auth: { status: "unauthenticated", action },
      }),
    );
    expect(text()).toContain("Open this page.");
    const link = container.querySelector<HTMLAnchorElement>('a[href="https://example.com/device"]');
    expect(link?.textContent).toContain("Continue authentication");
    link!.addEventListener("click", (event) => event.preventDefault());
    await act(async () => link!.click());
    expect(onAcceptUrlAuth).toHaveBeenCalledExactlyOnceWith(action);
  });

  it("reads this agent only, and looks again after an install", async () => {
    await show(agent("grok", signedOut));
    const options = mocks.panelOptions.mock.lastCall![0] as {
      providers: ReadonlyArray<ServerProvider>;
      onInstallClosed: () => void;
    };
    expect(options.providers.map((provider) => provider.instanceId)).toEqual(["grok"]);
    await act(async () => options.onInstallClosed());
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId: ProviderInstanceId.make("grok"), fresh: true },
    });
  });
});
