import { RegistryContext } from "@effect/atom-react";
import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
} from "@specweave-studio/client-runtime/connection";
import {
  AuthProvidersManageScope,
  AuthTerminalOperateScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentSearch,
  type AuthEnvironmentScope,
  type AuthSessionState,
  type ResolvedKeybindingsConfig,
  type ServerProvider,
  type ServerSettings,
  type TerminalCloseInput,
  type TerminalOpenInput,
  type TerminalWriteInput,
} from "@specweave-studio/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@specweave-studio/shared/keybindings";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type SessionResult = AsyncResult.AsyncResult<AuthSessionState, Error>;
type CommandResult = AsyncResult.AsyncResult<void, Error>;
type Request<Input> = { environmentId: EnvironmentId; input: Input };
type SetupConfig = {
  cwd: string;
  settings: ServerSettings;
  environment: { platform: { os: "darwin" } };
  keybindings: ResolvedKeybindingsConfig;
};
const state = vi.hoisted(() => ({
  registry: null as AtomRegistry.AtomRegistry | null,
  sessions: new Map<EnvironmentId, Atom.Writable<SessionResult>>(),
  providers: new Map<EnvironmentId, Atom.Writable<ReadonlyArray<ServerProvider>>>(),
  configs: new Map<EnvironmentId, Atom.Atom<SetupConfig>>(),
  open: vi.fn<(request: Request<TerminalOpenInput>) => Promise<CommandResult>>(),
  write: vi.fn<(request: Request<TerminalWriteInput>) => Promise<CommandResult>>(),
  close: vi.fn<(request: Request<TerminalCloseInput>) => Promise<CommandResult>>(),
  refresh: vi.fn(),
  updateSettings: vi.fn(),
  search: null as AgentSearch | null,
  find: vi.fn(),
  viewport: null as { onSessionExited: () => void } | null,
  codex: [] as Array<Record<string, unknown>>,
  claude: [] as Array<Record<string, unknown>>,
  pair: vi.fn(),
  createProject: vi.fn(),
  importThreads: vi.fn(),
  complete: vi.fn<() => Promise<void>>(),
  done: vi.fn(),
}));

// The machine choice and its invitation have their own tests.
vi.mock("./ProjectsFolderChoice", () => ({ ProjectsFolderChoice: () => null }));
vi.mock("../../hooks/useProjectFolderChoice", () => ({ rememberRecentFolder: () => {} }));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNickname: (_id: string, label?: string | null) => label ?? "",
  useMachineNicknames: () => (id: string, label?: string | null) => label ?? id,
  machineNickname: (id: string, label?: string | null) => label ?? id,
}));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: undefined }));
vi.mock("@specweave-studio/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({
    sessionStateAtom: (id: EnvironmentId) => state.sessions.get(id)!,
  }),
}));
vi.mock("../../rpc/atomRegistry", () => ({
  get appAtomRegistry() {
    return state.registry;
  },
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({ environments: [remoteEnvironment] }),
  usePrimaryEnvironment: () => primaryEnvironment,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: (id: EnvironmentId) => state.providers.get(id)!,
    configValueAtom: (id: EnvironmentId) => state.configs.get(id)!,
    refreshProviders: "refresh",
    updateSettings: "updateSettings",
    providerAuthState: () => null,
    startProviderAuth: "startAuth",
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null }),
}));
vi.mock("../../state/terminal", () => ({
  terminalEnvironment: { open: "open", write: "write", close: "close" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (
    command:
      | "open"
      | "write"
      | "close"
      | "refresh"
      | "updateSettings"
      | "pair"
      | "createProject"
      | "importThreads",
  ) => state[command],
}));
vi.mock("./SignInFirstStep", () => ({ SignInFirstStep: () => null }));
vi.mock("../../connection/onboarding", () => ({ connectPairing: "pair" }));
vi.mock("../../state/agentSessions", () => ({
  agentSessionImport: "importThreads",
  agentSessionScan: vi.fn(),
}));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "createProject" } }));
vi.mock("../../state/entities", () => ({ readProjects: () => [], useProjects: () => [] }));
vi.mock("../../onboarding/useProjectScans", () => ({ useProjectScans: () => [] }));
vi.mock("../ui/dialog", () => ({
  Dialog: "div",
  DialogPopup: "div",
  DialogTitle: "div",
  DialogHeader: "div",
}));
vi.mock("../ui/dialog-close-button", () => ({ DialogCloseButton: "button" }));
vi.mock("../ui/wizard", () => ({
  WizardPanel: "div",
  WizardPopup: "div",
  WizardHeader: "div",
  WizardFooter: ({ children, leading }: { children: ReactNode; leading?: ReactNode }) => (
    <div>
      {leading}
      {children}
    </div>
  ),
  WizardSteps: ({ onStepChange }: { onStepChange: (step: number) => void }) => (
    <button onClick={() => onStepChange(0)}>Back</button>
  ),
}));
vi.mock("../ui/scroll-area", () => ({ ScrollArea: "div" }));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => state.complete }));
vi.mock("../../hooks/useTheme", () => ({ mountOnboardingTheme: () => undefined }));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => [false, vi.fn()] }));
vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
  writeTextToClipboard: vi.fn(),
}));
vi.mock("../../cloud/publicConfig", () => ({ hasCloudPublicConfig: () => false }));
vi.mock("../clerk/useStudioConnectAuthPrompt", () => ({ useStudioConnectAuthPrompt: vi.fn() }));
vi.mock("@clerk/react", () => ({ useAuth: vi.fn() }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("../../providerInstances", () => ({
  resolveDefaultProviderModelSelection: vi.fn(),
  acpAgentIdForInstanceConfig: () => undefined,
}));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: (props: {
    onboardingMenu?: ReactNode;
    onboardingSignedOutFooter?: ReactNode;
  }) => {
    state.codex.push(props);
    return (
      <div data-codex-row>
        {props.onboardingMenu}
        {props.onboardingSignedOutFooter}
      </div>
    );
  },
  AddManagedCodexAccountDialog: () => <div data-add-chatgpt-account />,
}));
vi.mock("../settings/ClaudeSignIn", () => ({
  ClaudeSignIn: (props: Record<string, unknown>) => {
    state.claude.push(props);
    return <div data-claude-sign-in />;
  },
}));
vi.mock("../settings/ProviderAuthenticationSection", () => ({
  ProviderAuthenticationSection: () => <div data-app-sign-in />,
}));
vi.mock("../settings/AddProviderInstanceDialog", () => ({
  AddProviderInstanceDialog: () => <div data-add-agent />,
}));
vi.mock("../settings/RedactedSensitiveText", () => ({
  RedactedSensitiveText: ({ value }: { value: string }) => value,
}));
vi.mock("../settings/FoundAgents", async (original) => ({
  ...(await original<typeof import("../settings/FoundAgents")>()),
  useAgentSearch: () => ({ search: state.search, searching: false, find: state.find }),
}));
vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../ui/menu", () => ({
  Menu: "div",
  MenuPopup: "div",
  MenuItem: "button",
  MenuTrigger: ({
    render,
    children,
  }: {
    render?: { props: { disabled?: boolean } };
    children: ReactNode;
  }) => <button disabled={render?.props.disabled === true}>{children}</button>,
}));
vi.mock("../settings/providerDriverMeta", () => ({
  getDriverOption: (driver: string) => ({ label: driver }),
}));
vi.mock("../settings/providerStatus", () => ({
  getProviderSummary: () => ({ headline: "Setup required" }),
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ThreadTerminalDrawer", () => ({
  TerminalViewport: (props: { onSessionExited: () => void }) => {
    state.viewport = props;
    return <div data-terminal-viewport />;
  },
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/checkbox", () => ({ Checkbox: "input" }));
vi.mock("../ui/collapsible", () => ({
  Collapsible: "div",
  CollapsiblePanel: "div",
  CollapsibleTrigger: "button",
}));
vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn(), update: vi.fn(), close: vi.fn() },
}));

import { WelcomeWizard } from "./WelcomeWizard";

const primaryId = EnvironmentId.make("primary");
const remoteId = EnvironmentId.make("paired-remote");
const primaryEnvironment = {
  environmentId: primaryId,
  label: "This computer",
  connection: { phase: "connected" },
  entry: {
    target: new PrimaryConnectionTarget({
      environmentId: primaryId,
      label: "This computer",
      httpBaseUrl: "http://127.0.0.1:8319",
      wsBaseUrl: "ws://127.0.0.1:8319",
    }),
  },
} as const;
const remoteEnvironment = {
  environmentId: remoteId,
  label: "Paired computer",
  connection: { phase: "connected" },
  entry: {
    target: new BearerConnectionTarget({
      environmentId: remoteId,
      label: "Paired computer",
      connectionId: "paired-remote",
    }),
  },
} as const;
const missingClaude: ServerProvider = {
  instanceId: ProviderInstanceId.make("claude-work"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: false,
  version: null,
  status: "error",
  auth: { status: "unknown" },
  checkedAt: "2026-09-05T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const signedOutGrok: ServerProvider = {
  ...missingClaude,
  instanceId: ProviderInstanceId.make("grok-work"),
  driver: ProviderDriverKind.make("grok"),
  displayName: "Grok",
  installed: true,
  auth: { status: "unauthenticated" },
};
const signedInGrok: ServerProvider = {
  ...signedOutGrok,
  status: "ready",
  auth: { status: "authenticated" },
};
const session = (scopes: readonly AuthEnvironmentScope[]): AuthSessionState => ({
  authenticated: true,
  scopes,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "studio_session",
  },
});
function setAccess(environmentId: EnvironmentId, allowed: boolean) {
  state.registry!.set(
    state.sessions.get(environmentId)!,
    AsyncResult.success(
      session(
        allowed ? [AuthProvidersManageScope, AuthTerminalOperateScope] : [AuthProvidersManageScope],
      ),
    ),
  );
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function text(node: ReactTestInstance | string): string {
  return typeof node === "string" ? node : node.children.map(text).join("");
}
let renderer: ReactTestRenderer | undefined;
function button(label: string) {
  return renderer!.root.findAllByType("button").find((node) => text(node) === label)!;
}
async function click(label: string) {
  const node = button(label);
  expect(node).toBeDefined();
  expect(node.props.disabled).not.toBe(true);
  await act(async () => node.props.onClick());
}
function hasViewport() {
  return renderer!.root.findAllByProps({ "data-terminal-viewport": true }).length > 0;
}
async function enterRemoteAgents() {
  await act(async () => {
    renderer = create(
      <RegistryContext.Provider value={state.registry!}>
        <WelcomeWizard localAvailable onDone={state.done} />
      </RegistryContext.Provider>,
    );
  });
  await click("Continue");
  expect(text(renderer!.root)).toContain("Paired computer");
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("document", {
    activeElement: null,
    body: {},
    documentElement: { dataset: {} },
    getElementById: () => null,
  });
  state.registry = AtomRegistry.make();
  for (const id of [primaryId, remoteId]) {
    state.sessions.set(
      id,
      Atom.make<SessionResult>(
        AsyncResult.success(session([AuthProvidersManageScope, AuthTerminalOperateScope])),
      ).pipe(Atom.keepAlive),
    );
    state.providers.set(
      id,
      Atom.make<ReadonlyArray<ServerProvider>>([missingClaude, signedOutGrok]).pipe(Atom.keepAlive),
    );
    state.configs.set(
      id,
      Atom.make<SetupConfig>({
        cwd: `/fixtures/${id}`,
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [signedOutGrok.instanceId]: {
              driver: signedOutGrok.driver,
              config: { binaryPath: "/opt/grok-work" },
            },
          },
        },
        environment: { platform: { os: "darwin" } },
        keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
      }),
    );
  }
  state.open.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.write.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.close.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.refresh.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateSettings.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.find.mockReset();
  state.search = null;
  state.viewport = null;
  state.codex = [];
  state.claude = [];
  state.pair.mockReset().mockResolvedValue(AsyncResult.success(remoteId));
  state.complete.mockReset().mockResolvedValue(undefined);
  state.done.mockReset();
});

afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  state.registry?.dispose();
  state.sessions.clear();
  state.providers.clear();
  state.configs.clear();
  vi.unstubAllGlobals();
});

const install = () => button("Claude Code");
const setProviders = (id: EnvironmentId, providers: ReadonlyArray<ServerProvider>) =>
  act(async () => {
    state.registry!.set(state.providers.get(id)!, providers);
  });

describe("the agents step: install panel", () => {
  it("disables both setup actions for the paired read-only connection and preserves local completion", async () => {
    setAccess(remoteId, false);
    await enterRemoteAgents();
    expect(button("Install one").props.disabled).toBe(true);
    expect(button("Sign in").props.disabled).toBe(true);
    expect(text(renderer!.root)).toContain("This connection cannot control terminals.");
    await act(async () => {
      install().props.onClick();
      button("Sign in").props.onClick();
    });
    expect(state.open).not.toHaveBeenCalled();
    expect(state.write).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    await click("Continue without an agent");
    await click("Do not import projects");
    expect(state.complete).toHaveBeenCalledOnce();
    expect(state.done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("names agents that are not installed in one line, with Install one", async () => {
    state.search = {
      agents: [
        { agent: "claudeAgent", kind: "builtIn", command: "claude", state: "not-installed" },
        { agent: "cursor", kind: "builtIn", command: "cursor-agent", state: "not-installed" },
      ],
      pending: [],
      searched: [],
    };
    await enterRemoteAgents();
    expect(text(renderer!.root)).toContain("Not installed: Claude Code, cursor.");
    // Only an agent with a known installer is offered.
    expect(install()).toBeDefined();
    expect(button("cursor")).toBeUndefined();
  });

  it("rejects a retained install action after revocation and allows a terminal-only regrant", async () => {
    setAccess(primaryId, false);
    await enterRemoteAgents();
    const start = install().props.onClick;
    await act(async () => {
      setAccess(remoteId, false);
      start();
    });
    expect(state.open).not.toHaveBeenCalled();
    expect(button("Install one").props.disabled).toBe(true);
    await act(async () => setAccess(remoteId, true));
    expect(button("Install one").props.disabled).toBe(false);
    await act(async () => install().props.onClick());
    expect(state.open).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: "onboarding-agent-setup",
        terminalId: expect.any(String),
        cwd: "/fixtures/paired-remote",
        providerInstanceId: missingClaude.instanceId,
      },
    });
    // An install is typed and waits for Enter, so the person reads what will run.
    expect(state.write).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: "onboarding-agent-setup",
        terminalId: state.open.mock.calls[0]![0].input.terminalId,
        data: "curl -fsSL https://claude.ai/install.sh | bash",
      },
    });
    expect(text(renderer!.root)).toContain("Review the command, then press Enter to run it.");
    expect(hasViewport()).toBe(true);
    await click("Close");
    expect(state.close).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: "onboarding-agent-setup",
        terminalId: state.open.mock.calls[0]![0].input.terminalId,
        deleteHistory: true,
      },
    });
    // After an install the machine is read again and searched again.
    expect(state.find).toHaveBeenCalledOnce();
  });

  it("checks access when a queued retry starts and recovers after regrant", async () => {
    state.open.mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Could not open"))));
    await enterRemoteAgents();
    await click("Claude Code");
    const closing = deferred<CommandResult>();
    state.close.mockReturnValueOnce(closing.promise);
    await click("Retry");
    expect(state.close).toHaveBeenCalledOnce();
    expect(state.open).toHaveBeenCalledOnce();
    await act(async () => {
      setAccess(remoteId, false);
      closing.resolve(AsyncResult.success(undefined));
    });
    expect(state.open).toHaveBeenCalledOnce();
    expect(button("Retry").props.disabled).toBe(true);
    expect(state.write).not.toHaveBeenCalled();
    await act(async () => setAccess(remoteId, true));
    await click("Retry");
    expect(state.open).toHaveBeenCalledTimes(2);
    expect(state.write).toHaveBeenCalledOnce();
    expect(hasViewport()).toBe(true);
  });

  it("keeps an accepted terminal visible without pretyping when access is revoked during open", async () => {
    const opening = deferred<CommandResult>();
    state.open.mockReturnValueOnce(opening.promise);
    await enterRemoteAgents();
    await click("Claude Code");
    await act(async () => {
      setAccess(remoteId, false);
      opening.resolve(AsyncResult.success(undefined));
    });
    expect(state.write).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
    expect(hasViewport()).toBe(true);
    expect(text(renderer!.root)).toContain("This connection cannot control terminals.");
    await act(async () => setAccess(remoteId, true));
    expect(state.open).toHaveBeenCalledOnce();
    expect(state.write).not.toHaveBeenCalled();
    expect(text(renderer!.root)).toContain(
      "Run curl -fsSL https://claude.ai/install.sh | bash in this",
    );
    await act(async () => setAccess(remoteId, false));
    await click("Close");
    expect(hasViewport()).toBe(false);
    expect(state.close).not.toHaveBeenCalled();
    await click("Continue without an agent");
    expect(text(renderer!.root)).toContain("Choose your projects");
  });

  it("settles accepted pretyping locally after revocation without closing the PTY", async () => {
    const writing = deferred<CommandResult>();
    state.write.mockReturnValueOnce(writing.promise);
    await enterRemoteAgents();
    await click("Claude Code");
    await act(async () => {
      setAccess(remoteId, false);
      writing.resolve(AsyncResult.success(undefined));
    });
    expect(state.open).toHaveBeenCalledOnce();
    expect(state.write).toHaveBeenCalledOnce();
    expect(hasViewport()).toBe(true);
    await act(async () => setAccess(remoteId, true));
    expect(text(renderer!.root)).toContain("Review the command, then press Enter to run it.");
    expect(state.open).toHaveBeenCalledOnce();
    expect(state.write).toHaveBeenCalledOnce();
    await act(async () => setAccess(remoteId, false));
    await click("Close");
    expect(state.close).not.toHaveBeenCalled();
  });

  it("rechecks the original environment when cleanup runs after pending pretyping", async () => {
    const writing = deferred<CommandResult>();
    state.write.mockReturnValueOnce(writing.promise);
    await enterRemoteAgents();
    await click("Claude Code");
    await click("Back");
    expect(state.close).not.toHaveBeenCalled();
    await act(async () => {
      setAccess(remoteId, false);
      writing.resolve(AsyncResult.success(undefined));
    });
    expect(state.close).not.toHaveBeenCalled();
    expect(text(renderer!.root)).toContain("Connect your computers");
  });
});

describe("the agents step: sign-in", () => {
  it("runs the agent's own sign-in in the panel, with nothing to type", async () => {
    setAccess(primaryId, false);
    await enterRemoteAgents();
    await click("Sign in");
    expect(state.open).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: {
        threadId: "onboarding-agent-setup",
        terminalId: expect.any(String),
        cwd: "/fixtures/paired-remote",
        providerInstanceId: signedOutGrok.instanceId,
        command: "/opt/grok-work login",
      },
    });
    expect(state.write).not.toHaveBeenCalled();
    expect(hasViewport()).toBe(true);
    expect(text(renderer!.root)).toContain(
      "Grok's sign-in is running here. Its row updates when it is done.",
    );
    expect(text(renderer!.root)).not.toContain("press Enter");
    // One sign-in at a time.
    expect(button("Sign in").props.disabled).toBe(true);
  });

  it("reads the agent at once when its sign-in command ends, and says Checking", async () => {
    await enterRemoteAgents();
    await click("Sign in");
    const reading = deferred<AsyncResult.AsyncResult<unknown, Error>>();
    state.refresh.mockClear().mockReturnValueOnce(reading.promise);
    await act(async () => state.viewport!.onSessionExited());
    expect(hasViewport()).toBe(false);
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: { instanceId: signedOutGrok.instanceId, fresh: true },
    });
    expect(text(renderer!.root)).toContain("Checking…");
    expect(button("Sign in")).toBeUndefined();
    await setProviders(remoteId, [missingClaude, signedInGrok]);
    await act(async () =>
      reading.resolve(AsyncResult.success({ providers: [missingClaude, signedInGrok] })),
    );
    expect(state.refresh).toHaveBeenCalledOnce();
    expect(text(renderer!.root)).toContain("Ready: Grok.");
    expect(button("Sign in")).toBeUndefined();
  });

  it("says so on the row when the sign-in ends and the agent is still signed out", async () => {
    await enterRemoteAgents();
    await click("Sign in");
    await act(async () => state.viewport!.onSessionExited());
    expect(hasViewport()).toBe(false);
    expect(text(renderer!.root)).toContain(
      "The sign-in ended before Grok was signed in. Try again.",
    );
    expect(button("Sign in").props.disabled).toBe(false);
    // Starting it again takes the line away.
    await click("Sign in");
    expect(text(renderer!.root)).not.toContain("The sign-in ended before");
  });

  it("reads the agent by itself when its sign-in ends, and once more while it is signed out", async () => {
    await enterRemoteAgents();
    await click("Sign in");
    state.refresh.mockClear();
    await act(async () => state.viewport!.onSessionExited());
    // The first read cannot join one that began before the sign-in saved the account.
    expect(state.refresh.mock.calls).toEqual([
      [{ environmentId: remoteId, input: { instanceId: signedOutGrok.instanceId, fresh: true } }],
      [{ environmentId: remoteId, input: { instanceId: signedOutGrok.instanceId } }],
    ]);
  });

  it("reads the agent once when that answer says it is signed in", async () => {
    await enterRemoteAgents();
    await click("Sign in");
    state.refresh.mockClear();
    state.refresh.mockResolvedValueOnce(AsyncResult.success({ providers: [signedInGrok] }));
    await act(async () => state.viewport!.onSessionExited());
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
      environmentId: remoteId,
      input: { instanceId: signedOutGrok.instanceId, fresh: true },
    });
  });

  it("closes the panel once the machine reads the agent as signed in", async () => {
    await enterRemoteAgents();
    await click("Sign in");
    expect(hasViewport()).toBe(true);
    await setProviders(remoteId, [missingClaude, signedInGrok]);
    expect(hasViewport()).toBe(false);
    expect(state.close).toHaveBeenCalledOnce();
  });

  it("asks the machine about that agent while its sign-in runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      await enterRemoteAgents();
      await click("Sign in");
      state.refresh.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(state.refresh).toHaveBeenCalledExactlyOnceWith({
        environmentId: remoteId,
        input: { instanceId: signedOutGrok.instanceId },
      });
      await click("Close");
      state.refresh.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(9_000);
      });
      expect(state.refresh).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("signs Claude in with its own sign-in, never a terminal", async () => {
    const unverified: ServerProvider = {
      ...missingClaude,
      installed: true,
      status: "warning",
      auth: { status: "unknown" },
    };
    await setProviders(remoteId, [unverified, signedOutGrok]);
    await enterRemoteAgents();
    expect(renderer!.root.findAllByProps({ "data-claude-sign-in": true }).length).toBe(1);
    expect(state.claude.at(-1)).toMatchObject({
      environmentId: remoteId,
      environmentLabel: "Paired computer",
      instanceId: unverified.instanceId,
      os: "darwin",
      command: "claude auth login",
      readOnly: false,
    });
    expect(button("Open terminal")).toBeUndefined();
    expect(text(renderer!.root)).toContain("Could not confirm");
    expect(state.open).not.toHaveBeenCalled();
  });

  it("gives Codex its row, its menu and its command", async () => {
    const signedOutCodex: ServerProvider = {
      ...signedOutGrok,
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
    };
    await setProviders(remoteId, [signedOutCodex]);
    await enterRemoteAgents();
    expect(state.codex.at(-1)).toMatchObject({
      presentation: "onboarding",
      environmentId: remoteId,
      instanceId: signedOutCodex.instanceId,
      provider: signedOutCodex,
      mode: "existing",
    });
    expect(text(renderer!.root)).toContain("codex login");
    await click("Add another ChatGPT account");
    expect(renderer!.root.findAllByProps({ "data-add-chatgpt-account": true }).length).toBe(1);
  });
});

describe("the agents step: found agents", () => {
  const found = (agents: AgentSearch["agents"]): AgentSearch => ({
    agents,
    pending: [],
    searched: [],
  });

  it("turns a found, signed-out agent on with Sign in and goes straight to its sign-in", async () => {
    state.search = found([
      { agent: "grok", kind: "builtIn", command: "grok", state: "signed-out" },
    ]);
    await setProviders(remoteId, [missingClaude]);
    await enterRemoteAgents();
    expect(text(renderer!.root)).toContain("Installed, not signed in.");
    await click("Sign in");
    expect(state.updateSettings).toHaveBeenCalledOnce();
    const patch = state.updateSettings.mock.calls[0]![0].input.patch;
    expect(patch.providerInstances.grok).toMatchObject({ driver: "grok", enabled: true });
    expect(state.open).not.toHaveBeenCalled();
    // The machine lists the agent, now on: its sign-in starts with no second click.
    await setProviders(remoteId, [
      missingClaude,
      { ...signedOutGrok, instanceId: ProviderInstanceId.make("grok") },
    ]);
    expect(state.open).toHaveBeenCalledOnce();
    expect(state.open.mock.calls[0]![0].input).toMatchObject({
      providerInstanceId: "grok",
      command: "grok login",
    });
  });

  it("turns a found, signed-in agent on without a sign-in", async () => {
    state.search = found([{ agent: "muse", kind: "builtIn", command: "muse", state: "ready" }]);
    await setProviders(remoteId, [missingClaude]);
    await enterRemoteAgents();
    expect(text(renderer!.root)).toContain("Signed in, not turned on.");
    await click("Turn on");
    expect(state.updateSettings.mock.calls[0]![0].input.patch.providerInstances.muse).toMatchObject(
      { driver: "muse", enabled: true },
    );
    expect(state.open).not.toHaveBeenCalled();
  });

  it("opens the add dialog for an agent the registry offers", async () => {
    state.search = found([
      { agent: "gemini", kind: "registry", command: "gemini", state: "installed" },
    ]);
    await enterRemoteAgents();
    expect(text(renderer!.root)).toContain("Installed, not added.");
    await click("Add agent");
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    expect(renderer!.root.findAllByProps({ "data-add-agent": true }).length).toBe(1);
  });
});

describe("the agents step: readiness", () => {
  it("says chats will not start until an agent is ready, then names the ready agent", async () => {
    await enterRemoteAgents();
    expect(text(renderer!.root)).toContain("No agent is ready yet, so chats will not start.");
    expect(text(renderer!.root)).toContain("Settings > Providers");
    expect(button("Continue without an agent")).toBeDefined();
    await act(async () => {
      for (const id of [primaryId, remoteId]) {
        state.registry!.set(state.providers.get(id)!, [missingClaude, signedInGrok]);
      }
    });
    expect(text(renderer!.root)).toContain("Ready: Grok.");
    expect(button("Continue")).toBeDefined();
    expect(button("Continue without an agent")).toBeUndefined();
  });

  it("stops saying checking when a provider never finishes its probe", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const neverProbed: ServerProvider = { ...missingClaude, status: "warning" };
      await act(async () => {
        state.registry!.set(state.providers.get(remoteId)!, [neverProbed]);
      });
      await enterRemoteAgents();
      expect(text(renderer!.root)).toContain("Checking which agents can run");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(text(renderer!.root)).toContain("No agent is ready yet");
      expect(button("Continue without an agent")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads and searches a machine again on Check again", async () => {
    await enterRemoteAgents();
    state.refresh.mockClear();
    await click("Check again");
    expect(state.refresh).toHaveBeenCalledExactlyOnceWith({ environmentId: remoteId, input: {} });
    expect(state.find).toHaveBeenCalledOnce();
  });
});
