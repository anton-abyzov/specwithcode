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

const mocks = vi.hoisted(() => ({
  canManage: true,
  auth: { data: null as { phase: string } | null, error: null as Error | null },
  start: vi.fn(),
  claude: vi.fn(),
  appSignIn: vi.fn(),
  copy: vi.fn(),
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.canManage }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => mocks.auth }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { providerAuthState: () => "auth-state", startProviderAuth: "start" },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.start }));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: mocks.copy }));
vi.mock("../chat/ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: (props: { driverKind: string; acpRegistryAgentId?: string }) => (
    <i data-icon={props.driverKind} data-registry-agent={props.acpRegistryAgentId ?? ""} />
  ),
}));
vi.mock("../settings/RedactedSensitiveText", () => ({
  RedactedSensitiveText: ({ value }: { value: string }) => <span data-redacted>{value}</span>,
}));
vi.mock("../settings/ClaudeSignIn", () => ({
  ClaudeSignIn: (props: Record<string, unknown>) => {
    mocks.claude(props);
    return (
      <section data-testid="claude-sign-in">
        <button>Sign in with Claude</button>
      </section>
    );
  },
}));
vi.mock("../settings/ProviderAuthenticationSection", () => ({
  ProviderAuthenticationSection: (props: Record<string, unknown>) => {
    mocks.appSignIn(props);
    return (
      <section data-testid="app-sign-in">
        <button>Sign in</button>
      </section>
    );
  },
}));

import { AgentCommand, AgentRow, AgentRowStatus } from "./AgentRow";
import { FoundAgentRow, ProviderAgentRow, signsInThroughApp } from "./AgentRows";

const environmentId = EnvironmentId.make("this-computer");
const agent = (driver: string, patch: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-12T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...patch,
});
const signedOut = { status: "error", auth: { status: "unauthenticated" } } as const;

let root: Root;
let container: HTMLDivElement;
const onOpenPanel = vi.fn();
const onAutoSignInDone = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.canManage = true;
  mocks.auth = { data: null, error: null };
  mocks.copy.mockResolvedValue(undefined);
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

type RowProps = Partial<Parameters<typeof ProviderAgentRow>[0]>;
const row = (provider: ServerProvider, props: RowProps = {}) => (
  <ProviderAgentRow
    environmentId={environmentId}
    machineLabel="Office Mac"
    provider={provider}
    name={provider.displayName ?? provider.driver}
    os="darwin"
    command={null}
    panelOpen={false}
    panelAvailable
    onOpenPanel={onOpenPanel}
    {...props}
  />
);
const show = (provider: ServerProvider, props: RowProps = {}) =>
  act(async () => root.render(row(provider, props)));
const text = () => container.textContent ?? "";
const buttons = () => [...container.querySelectorAll("button")];
const button = (label: string) => buttons().find((element) => element.textContent === label);
const rowElement = () => container.querySelector<HTMLElement>("[data-agent-row]")!;

describe("an agent's row", () => {
  it("shows the name, what it uses, its state and its one button", async () => {
    await act(async () =>
      root.render(
        <AgentRow
          agent="grok"
          state="signIn"
          icon={<i />}
          name="Grok"
          uses="Uses your Grok account"
          detail="Not signed in."
          status={<AgentRowStatus tone="quiet">Off</AgentRowStatus>}
          action={<button>Sign in</button>}
        />,
      ),
    );
    expect(rowElement().dataset.agentRow).toBe("grok");
    expect(rowElement().dataset.agentState).toBe("signIn");
    expect(container.querySelector("h3")?.textContent).toBe("Grok");
    expect(text()).toContain("Uses your Grok account");
    expect(text()).toContain("Not signed in.");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Off");
    expect(buttons().map((element) => element.textContent)).toEqual(["Sign in"]);
  });

  it("keeps the command behind Show command, with a copy button", async () => {
    await act(async () => root.render(<AgentCommand command="grok login" note="A note." />));
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Show command");
    expect(details.querySelector("code")?.textContent).toBe("grok login");
    expect(details.textContent).toContain("A note.");
    const copy = details.querySelector<HTMLButtonElement>('button[aria-label="Copy command"]')!;
    await act(async () => copy.click());
    expect(mocks.copy).toHaveBeenCalledWith("grok login");
    expect(details.querySelector('button[aria-label="Copied"]')).not.toBeNull();
  });
});

describe("an agent that is on", () => {
  it("is Ready with its account and plan, and has no button", async () => {
    await show(
      agent("claudeAgent", {
        displayName: "Claude Code",
        auth: { status: "authenticated", email: "ada@example.com", label: "Max" },
      }),
    );
    expect(rowElement().dataset.agentState).toBe("ready");
    expect(container.querySelector('[data-agent-status="ready"]')?.textContent).toBe("Ready");
    expect(text()).toContain("Uses your Claude plan");
    expect(text()).toContain("Signed in as ada@example.com. Plan: Max.");
    expect(buttons()).toEqual([]);
    expect(container.querySelector('[data-testid="claude-sign-in"]')).toBeNull();
  });

  it("names a signed-in account that has no email by its login", async () => {
    await show(agent("grok", { auth: { status: "authenticated", login: "ada" } }));
    expect(text()).toContain("Signed in as ada.");
  });

  it("signs Claude in with the app's own sign-in, and no terminal", async () => {
    const claude = agent("claudeAgent", { displayName: "Claude Code", ...signedOut });
    await show(claude, { command: "claude auth login", os: "windows" });
    expect(container.querySelector('[data-testid="claude-sign-in"]')).not.toBeNull();
    expect(mocks.claude).toHaveBeenLastCalledWith({
      environmentId,
      environmentLabel: "Office Mac",
      instanceId: claude.instanceId,
      provider: claude,
      os: "windows",
      command: "claude auth login",
      readOnly: false,
      autoStart: false,
      onAutoStartDone: undefined,
    });
    // The row adds no button of its own to the sign-in's one.
    expect(buttons().map((element) => element.textContent)).toEqual(["Sign in with Claude"]);
    expect(text()).not.toMatch(/terminal/i);
    expect(onOpenPanel).not.toHaveBeenCalled();
  });

  it("keeps Claude's sign-in read-only for a connection that cannot change agents", async () => {
    mocks.canManage = false;
    await show(agent("claudeAgent", signedOut));
    expect(mocks.claude.mock.lastCall?.[0]).toMatchObject({ readOnly: true });
  });

  it("offers Claude's sign-in when its sign-in could not be read", async () => {
    await show(agent("claudeAgent", { status: "warning", auth: { status: "unknown" } }));
    expect(container.querySelector('[data-testid="claude-sign-in"]')).not.toBeNull();
  });

  it("uses the app's sign-in for an agent that has one", async () => {
    const cursor = agent("cursor", {
      ...signedOut,
      setup: { canAuthenticate: true, canInstall: false },
    });
    expect(signsInThroughApp(cursor)).toBe(true);
    await show(cursor, { command: "cursor-agent login" });
    expect(container.querySelector('[data-testid="app-sign-in"]')).not.toBeNull();
    expect(mocks.appSignIn.mock.lastCall?.[0]).toMatchObject({
      environmentId,
      environmentLabel: "Office Mac",
      instanceId: cursor.instanceId,
      readOnly: false,
    });
    expect(buttons().map((element) => element.textContent)).toEqual(["Sign in"]);
    expect(onOpenPanel).not.toHaveBeenCalled();
  });

  it("passes a registry agent's identity to its icon and its words", async () => {
    await show(agent("acpRegistry", { displayName: "GitHub Copilot" }), {
      registryAgentId: "github-copilot-cli",
    });
    expect(rowElement().dataset.agentRow).toBe("github-copilot-cli");
    expect(container.querySelector("[data-icon]")?.getAttribute("data-registry-agent")).toBe(
      "github-copilot-cli",
    );
    expect(text()).toContain("Uses your GitHub Copilot plan");
  });

  it("gives every other signed-out agent one Sign in button that runs its command", async () => {
    const grok = agent("grok", { displayName: "Grok", ...signedOut });
    expect(signsInThroughApp(grok)).toBe(false);
    await show(grok, { command: "grok login" });
    expect(buttons().filter((element) => !element.closest("details")).length).toBe(1);
    expect(container.querySelector("details code")?.textContent).toBe("grok login");
    expect(text()).not.toMatch(/open a terminal|type the command/i);
    await act(async () => button("Sign in")!.click());
    expect(onOpenPanel).toHaveBeenCalledOnce();
  });

  it("leaves out the machine's own words, which say to run a command", async () => {
    const grok = agent("grok", {
      displayName: "Grok",
      ...signedOut,
      message: "Grok CLI is installed but not logged in. Run `grok login`.",
    });
    await show(grok, { command: "grok login" });
    expect(text()).toContain("Not authenticated");
    expect(text()).not.toContain("Run `grok login`");
    expect(text()).not.toContain("not logged in");
  });

  it("says a sign-in ended without signing in, once the machine has been read", async () => {
    const grok = agent("grok", { displayName: "Grok", ...signedOut });
    const ended = "The sign-in ended before Grok was signed in. Try again.";
    await show(grok, { command: "grok login", signInEnded: true, checking: true });
    expect(text()).not.toContain(ended);
    await show(grok, { command: "grok login", signInEnded: true });
    expect(text()).toContain(ended);
    expect(button("Sign in")!.disabled).toBe(false);
  });

  it("says how Pi signs in, since Pi has no sign-in command", async () => {
    await show(agent("pi", signedOut), { command: "pi" });
    expect(text()).toContain("Pi signs in from inside. Type /login once it has opened.");
  });

  it("cannot start a panel sign-in while a panel is open or without terminal access", async () => {
    const grok = agent("grok", signedOut);
    await show(grok, { command: "grok login", panelOpen: true });
    expect(button("Sign in")!.disabled).toBe(true);
    await show(grok, { command: "grok login", panelAvailable: false });
    expect(button("Sign in")!.disabled).toBe(true);
  });

  it("shows Checking at once after a sign-in the app started, in place of the button", async () => {
    await show(agent("grok", signedOut), { command: "grok login", checking: true });
    expect(rowElement().dataset.agentState).toBe("checking");
    expect(container.querySelector('[data-agent-status="checking"]')?.textContent).toBe(
      "Checking…",
    );
    expect(button("Sign in")).toBeUndefined();
  });

  it("keeps a sign-in on screen while the machine reads the agent again", async () => {
    await show(agent("claudeAgent", signedOut));
    expect(container.querySelector('[data-testid="claude-sign-in"]')).not.toBeNull();
    // A read in progress reports the agent as not checked yet.
    await show(
      agent("claudeAgent", { installed: false, status: "warning", auth: { status: "unknown" } }),
    );
    expect(container.querySelector('[data-testid="claude-sign-in"]')).not.toBeNull();
    await show(agent("claudeAgent"));
    expect(container.querySelector('[data-testid="claude-sign-in"]')).toBeNull();
    expect(container.querySelector('[data-agent-status="ready"]')).not.toBeNull();
  });

  it("gives the reason, and no sign-in, for a signed-in agent that is not ready", async () => {
    await show(
      agent("grok", {
        status: "error",
        message: "Grok could not list its models.",
        auth: { status: "authenticated" },
      }),
      { command: "grok login" },
    );
    expect(rowElement().dataset.agentState).toBe("attention");
    expect(buttons()).toEqual([]);
    expect(container.querySelector("details")).toBeNull();
  });

  it("goes straight to the panel for an agent turned on with Sign in", async () => {
    await show(agent("grok", signedOut), {
      command: "grok login",
      autoSignIn: true,
      onAutoSignInDone,
    });
    expect(onOpenPanel).toHaveBeenCalledOnce();
    expect(onAutoSignInDone).toHaveBeenCalledOnce();
  });

  it("starts the app's sign-in for an agent turned on with Sign in, once it can be read", async () => {
    const cursor = agent("cursor", {
      ...signedOut,
      setup: { canAuthenticate: true, canInstall: false },
    });
    await show(cursor, { autoSignIn: true, onAutoSignInDone });
    expect(mocks.start).not.toHaveBeenCalled();
    expect(onAutoSignInDone).not.toHaveBeenCalled();
    // The machine's answer arrives as a new render of the part that waits for it.
    mocks.auth = { data: { phase: "idle" }, error: null };
    const done = vi.fn();
    await show(cursor, { autoSignIn: true, onAutoSignInDone: done });
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId: cursor.instanceId },
    });
    expect(done).toHaveBeenCalledOnce();
    expect(onOpenPanel).not.toHaveBeenCalled();
  });

  it("hands Claude's sign-in the start, since it runs its own", async () => {
    await show(agent("claudeAgent", signedOut), { autoSignIn: true, onAutoSignInDone });
    expect(mocks.claude.mock.lastCall?.[0]).toMatchObject({
      autoStart: true,
      onAutoStartDone: onAutoSignInDone,
    });
    expect(onAutoSignInDone).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(onOpenPanel).not.toHaveBeenCalled();
  });

  it("starts nothing for an agent that turned out to be signed in already", async () => {
    await show(agent("grok"), { command: "grok login", autoSignIn: true, onAutoSignInDone });
    expect(onOpenPanel).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(onAutoSignInDone).toHaveBeenCalledOnce();
  });
});

describe("a found agent that is not on yet", () => {
  const onTurnOn = vi.fn();
  const onSignIn = vi.fn();
  const onAdd = vi.fn();
  type Found = Parameters<typeof FoundAgentRow>[0]["found"];
  const showFound = (found: Found, name: string, readOnly = false) =>
    act(async () =>
      root.render(
        <FoundAgentRow
          found={found}
          name={name}
          readOnly={readOnly}
          onTurnOn={onTurnOn}
          onSignIn={onSignIn}
          onAdd={onAdd}
        />,
      ),
    );

  it("has a Sign in button when it is installed and signed out", async () => {
    await showFound({ agent: "grok", kind: "builtIn", state: "signed-out" }, "Grok");
    expect(text()).toContain("Uses your Grok account");
    expect(text()).toContain("Installed, not signed in.");
    expect(buttons().map((element) => element.textContent)).toEqual(["Sign in"]);
    expect(buttons()[0]!.getAttribute("aria-label")).toBe("Sign in to Grok");
    await act(async () => buttons()[0]!.click());
    expect(onSignIn).toHaveBeenCalledOnce();
    expect(onTurnOn).not.toHaveBeenCalled();
  });

  it("has a Turn on button when it is signed in, and warns about Muse Code sharing", async () => {
    await showFound({ agent: "muse", kind: "builtIn", state: "ready" }, "Muse Code");
    expect(text()).toContain("Signed in, not turned on.");
    expect(text()).toContain("Muse Code can share your code with Meta");
    expect(buttons().map((element) => element.textContent)).toEqual(["Turn on"]);
    await act(async () => buttons()[0]!.click());
    expect(onTurnOn).toHaveBeenCalledOnce();
  });

  it("has an Add agent button for an agent the registry offers", async () => {
    await showFound({ agent: "gemini", kind: "registry", state: "installed" }, "Gemini CLI");
    expect(rowElement().dataset.agentState).toBe("not-added");
    expect(text()).toContain("Installed, not added.");
    expect(container.querySelector("[data-icon]")?.getAttribute("data-registry-agent")).toBe(
      "gemini",
    );
    expect(buttons().map((element) => element.textContent)).toEqual(["Add agent"]);
    await act(async () => buttons()[0]!.click());
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("has no button for a connection that cannot change agents", async () => {
    await showFound({ agent: "grok", kind: "builtIn", state: "installed" }, "Grok", true);
    expect(text()).toContain("Installed, not turned on.");
    expect(buttons()).toEqual([]);
  });
});
