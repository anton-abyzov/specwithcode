// @vitest-environment jsdom
// The walker contract (increment 1387, AC-36): the setup dialog names its step in
// `data-wizard-step`, and each step marks at most one enabled control
// `data-wizard-neutral`, the action that goes on without choosing, granting or
// importing anything. None is enabled while a step is busy. The headless checks
// walk setup on these attributes alone (scripts/studio-verify/first-run-walk.mjs).
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const world = vi.hoisted(() => ({
  cloud: false,
  auth: { isLoaded: true, isSignedIn: false, userId: null as string | null },
  link: {
    data: null as { linked: boolean; managedTunnelActive?: boolean } | null,
    isPending: false,
    error: null as string | null,
    target: { environmentId: "test-env" } as object | null,
  },
  reconcile: vi.fn(),
  scansPending: false,
  accept: vi.fn(),
  decline: vi.fn(),
  undo: vi.fn(),
  importThreads: vi.fn(),
  createProject: vi.fn(),
  complete: vi.fn(),
  refresh: vi.fn(),
}));

// The Chrome and Mac apps rows read live machine state; their own tests cover them.
vi.mock("./ChromeAccessRow", () => ({
  ChromeAccessRow: () => <li data-access-row="browser" />,
}));
vi.mock("./MacAppsRow", () => ({
  MacAppsRow: () => <li data-access-row="mac-apps" />,
}));
vi.mock("./IPhoneRow", () => ({
  IPhoneRow: () => <li data-access-row="iphone" />,
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => world.auth,
  useUser: () => ({ user: null }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("../clerk/useStudioConnectAuthPrompt", () => ({
  useStudioConnectAuthPrompt: () => ({
    authPrompt: null,
    openAuthPrompt: vi.fn(),
    openSetupAuthPrompt: vi.fn(),
  }),
}));
vi.mock("../../cloud/useCloudLinkController", () => ({
  useCloudLinkController: () => ({
    linkState: world.link,
    linked: world.link.data?.linked ?? false,
    publishAgentActivity: false,
    operationError: null,
    reconcileCloudState: world.reconcile,
  }),
}));
vi.mock("../../cloud/publicConfig", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cloud/publicConfig")>()),
  hasCloudPublicConfig: () => world.cloud,
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => ({ _tag: "Success" }) },
  useEnvironmentScope: () => true,
  useEnvironmentsWithScope: (environments: Array<{ environmentId: string }>) =>
    new Set(environments.map((entry) => entry.environmentId)),
  readEnvironmentScope: () => true,
}));
vi.mock("../../teamRules/useTeamRules", () => ({ useTeamRules: () => ({ summary: undefined }) }));
vi.mock("../../studio/fleet", () => ({
  useMachineWorkGrants: () => ({ snapshot: { grants: [] } }),
}));
vi.mock("../settings/AccountJoinCard", () => ({ AccountJoinCard: () => null }));
vi.mock("../../state/environments", () => {
  const environment = {
    environmentId: "test-env",
    label: "Computer",
    connection: { phase: "connected" },
    serverConfig: {
      environment: { platform: { os: "darwin" } },
      settings: { defaultRuntimeMode: "approval-required" },
    },
  };
  return {
    useEnvironments: () => ({ environments: [environment] }),
    usePrimaryEnvironment: () => environment,
    useRelayEnvironmentDiscovery: () => ({ environments: new Map() }),
  };
});
// Full access is not answered yet, so the Access step shows.
vi.mock("../../onboarding/accessRecommendation", () => ({
  useFullAccessRecommendation: () => ({
    answer: null,
    machineRole: null,
    hydrated: true,
    accept: world.accept,
    decline: world.decline,
    undo: world.undo,
  }),
}));
vi.mock("../access/FullDiskAccess", () => ({
  FullDiskAccessRow: () => null,
  FirstRunFullDiskAccess: () => null,
}));
vi.mock("./ProjectsFolderChoice", () => ({ ProjectsFolderChoice: () => null }));
vi.mock("../../hooks/useProjectFolderChoice", () => ({ rememberRecentFolder: () => {} }));
vi.mock("../github/StarOnGitHub", () => ({ StarOnGitHubLink: () => null }));
vi.mock("../../state/agentSessions", () => ({ agentSessionImport: "import" }));
vi.mock("../../state/projects", () => ({ projectEnvironment: { create: "create" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "import"
      ? world.importThreads
      : command === "create"
        ? world.createProject
        : world.refresh,
}));
vi.mock("../../onboarding/firstRun", () => ({ useCompleteOnboarding: () => world.complete }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [{ id: "test-project", environmentId: "test-env", workspaceRoot: "/project" }],
  readProjects: () => [
    { id: "test-project", environmentId: "test-env", workspaceRoot: "/project" },
  ],
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providersValueAtom: () => [],
    configValueAtom: () => null,
    refreshProviders: "refresh",
  },
}));
vi.mock("../../onboarding/useProjectScans", () => ({
  useProjectScans: (ids: readonly string[]) =>
    ids.map((environmentId) => ({
      environmentId,
      isPending: world.scansPending,
      error: null,
      refresh: world.refresh,
      data: world.scansPending
        ? null
        : {
            truncated: false,
            candidates: [
              {
                path: "/project",
                title: "project",
                projectId: "test-project",
                threadCount: 3,
                lastActiveAt: new Date().toISOString(),
                sources: ["codex"],
              },
            ],
          },
    })),
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: vi.fn() }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: {} }));
vi.mock("../ThreadTerminalDrawer", () => ({ TerminalViewport: () => null }));
vi.mock("../settings/ChatGptWelcomeCoordinator", () => ({ ChatGptWelcomeCoordinator: () => null }));
vi.mock("../settings/CodexSetupSection", () => ({
  CodexSetupSection: () => null,
  AddManagedCodexAccountDialog: () => null,
}));
vi.mock("./AgentRows", () => ({ FoundAgentRow: () => null, ProviderAgentRow: () => null }));
vi.mock("./MachineBasics", () => ({
  MachineBasics: ({ fallback }: { readonly fallback: ReactNode }) => fallback,
}));
vi.mock("../settings/FoundAgents", () => ({
  agentName: (agent: string) => agent,
  agentsWithProviderChecks: (agents: unknown) => agents,
  defaultAgentInstance: () => ({}),
  foundAgentsView: () => ({ rows: [] }),
  useAgentSearch: () => ({ search: null, searching: false, find: () => {} }),
}));
vi.mock("../cloud/CloudEnvironmentConnectList", () => ({
  CloudEnvironmentConnectRows: () => null,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn(), close: vi.fn(), update: vi.fn() } }));

import { WelcomeWizard } from "./WelcomeWizard";
import { WizardStepFooter } from "./WizardFrame";

let root: Root;
let container: HTMLDivElement;
const onDone = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  window.localStorage.clear();
  world.cloud = false;
  world.auth = { isLoaded: true, isSignedIn: false, userId: null };
  world.link = { data: null, isPending: false, error: null, target: { environmentId: "test-env" } };
  world.reconcile.mockResolvedValue(true);
  world.scansPending = false;
  world.accept.mockResolvedValue(new Map([["test-env", "approval-required"]]));
  world.decline.mockResolvedValue(undefined);
  world.undo.mockResolvedValue(true);
  world.importThreads.mockResolvedValue({
    _tag: "Success",
    value: { importedCount: 3, skippedCount: 0 },
  });
  world.complete.mockResolvedValue(undefined);
  world.refresh.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // As in the app, finishing setup leaves it for the workspace.
  onDone.mockImplementation(() => root.render(<p>Workspace</p>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (window as { desktopBridge?: unknown }).desktopBridge;
});

const enabled = (element: Element) =>
  !(element as HTMLButtonElement).disabled && element.getAttribute("aria-disabled") !== "true";

/** The open step and its enabled neutral controls; fails on two. */
function contract() {
  const dialogs = document.querySelectorAll("[data-wizard-step]");
  if (dialogs.length === 0) return { step: null, neutral: [] as HTMLElement[] };
  expect(dialogs).toHaveLength(1);
  const dialog = dialogs[0]!;
  const neutral = [...dialog.querySelectorAll<HTMLElement>("[data-wizard-neutral]")].filter(
    enabled,
  );
  expect(
    neutral.length,
    `step ${dialog.getAttribute("data-wizard-step")} has at most one enabled neutral control`,
  ).toBeLessThanOrEqual(1);
  return { step: dialog.getAttribute("data-wizard-step"), neutral };
}

/** What the shared walker does, in the page: press each step's neutral control until setup ends. */
async function walk() {
  const steps: string[] = [];
  for (let state = contract(); state.step !== null; state = contract()) {
    expect(state.neutral, `step ${state.step} has a neutral control`).toHaveLength(1);
    expect(steps.length).toBeLessThan(12);
    steps.push(state.step);
    await act(async () => state.neutral[0]!.click());
  }
  return steps;
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent?.trim() === label);
const render = (firstRun = false) =>
  act(async () =>
    root.render(<WelcomeWizard localAvailable firstRun={firstRun} onDone={onDone} />),
  );

it("walks setup from the connection step on neutral controls alone, and ends it", async () => {
  await render();
  expect(await walk()).toEqual(["connection", "agents", "access", "import"]);
  expect(onDone).toHaveBeenCalledOnce();
  expect(world.accept).not.toHaveBeenCalled();
  expect(world.importThreads).not.toHaveBeenCalled();
});

it("walks setup from the sign-in step without an account", async () => {
  world.cloud = true;
  Object.assign(window, { desktopBridge: {} });
  await render(true);
  expect(contract().neutral.map((element) => element.textContent?.trim())).toEqual([
    "Use without an account",
  ]);
  expect(await walk()).toEqual(["start", "agents", "access", "import"]);
  expect(onDone).toHaveBeenCalledOnce();
});

it("offers Continue as the neutral action once signed in, and none while this machine links", async () => {
  world.cloud = true;
  Object.assign(window, { desktopBridge: {} });
  world.auth = { isLoaded: true, isSignedIn: true, userId: "user_1" };
  world.link = { ...world.link, data: { linked: true, managedTunnelActive: true } };
  await render(true);
  expect(contract()).toMatchObject({ step: "start" });
  expect(contract().neutral.map((element) => element.textContent?.trim())).toEqual(["Continue"]);

  await act(async () => root.unmount());
  root = createRoot(container);
  world.link = { ...world.link, data: { linked: false } };
  world.reconcile.mockImplementation(() => new Promise<boolean>(() => {}));
  await render(true);
  expect(contract().step).toBe("start");
  expect(contract().neutral).toHaveLength(0);
  expect(button("Continue")).toBeDefined();
});

it("offers no neutral action while this machine's link is still being read", async () => {
  world.cloud = true;
  Object.assign(window, { desktopBridge: {} });
  world.auth = { isLoaded: true, isSignedIn: true, userId: "user_1" };
  world.link = { ...world.link, data: null, isPending: true };
  await render(true);
  expect(contract().step).toBe("start");
  expect(contract().neutral).toHaveLength(0);
});

it("keeps Continue as the Access step's one neutral control, also while an answer saves", async () => {
  let finish = (_: unknown) => {};
  world.accept.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  await render();
  await act(async () => contract().neutral[0]!.click());
  await act(async () => contract().neutral[0]!.click());
  expect(contract().step).toBe("access");
  expect(contract().neutral.map((element) => element.textContent?.trim())).toEqual(["Continue"]);
  // A row's answer is not the step's: it saves in place and Continue stays.
  await act(async () => button("Use Full access")!.click());
  expect(contract().step).toBe("access");
  expect(contract().neutral.map((element) => element.textContent?.trim())).toEqual(["Continue"]);
  await act(async () => finish(new Map([["test-env", "approval-required"]])));
  expect(contract().step).toBe("access");
  await act(async () => contract().neutral[0]!.click());
  expect(contract().step).toBe("import");
});

it("keeps focus on the neutral control when projects finish loading, so Enter imports nothing", async () => {
  world.scansPending = true;
  await render();
  for (let index = 0; index < 3; index++) await act(async () => contract().neutral[0]!.click());
  expect(contract().step).toBe("import");
  // The scans finish in the same mounted step: its footer is drawn again with Import enabled.
  world.scansPending = false;
  await render();
  expect(button("Import 1 project")).toBeDefined();
  expect(document.activeElement?.textContent?.trim()).toBe("Do not import projects");
  expect(document.activeElement?.hasAttribute("data-wizard-neutral")).toBe(true);
  expect(world.importThreads).not.toHaveBeenCalled();
});

it("keeps the import step's neutral control while projects load, and none while an import runs", async () => {
  world.scansPending = true;
  await render();
  for (let index = 0; index < 3; index++) await act(async () => contract().neutral[0]!.click());
  expect(contract().step).toBe("import");
  expect(contract().neutral.map((element) => element.textContent?.trim())).toEqual([
    "Do not import projects",
  ]);

  await act(async () => root.unmount());
  root = createRoot(container);
  world.scansPending = false;
  world.importThreads.mockImplementation(() => new Promise(() => {}));
  await render();
  for (let index = 0; index < 3; index++) await act(async () => contract().neutral[0]!.click());
  expect(contract().neutral).toHaveLength(1);
  await act(async () => button("Import 1 project")!.click());
  expect(contract().step).toBe("import");
  expect(contract().neutral).toHaveLength(0);
});

it("fails a footer that marks two neutral controls", async () => {
  await act(async () =>
    root.render(
      <div data-wizard-step="agents">
        <WizardStepFooter
          skip={{ label: "One", onClick: () => {}, neutral: true }}
          primary={{ label: "Two", onClick: () => {}, neutral: true }}
        />
      </div>,
    ),
  );
  expect(() => contract()).toThrow();
});
